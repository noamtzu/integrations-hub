import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { connectorsFromConfig } from "./connectors/registry.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createApp } from "./http/app.js";
import { genericSource, stripeSource, type Source } from "./ingest/sources.js";
import { createLogger } from "./logger.js";
import { createMetrics } from "./metrics.js";
import { DeliveryQueue } from "./queue/queue.js";
import { Worker } from "./queue/worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const pool = createPool(config.DATABASE_URL);
  pool.on("error", (err) => log.error({ err }, "idle Postgres client error"));

  const applied = await migrate(pool);
  if (applied.length) log.info({ applied }, "migrations applied");

  const sources: Source[] = [];
  if (config.STRIPE_WEBHOOK_SECRET) sources.push(stripeSource(config.STRIPE_WEBHOOK_SECRET, config.SIGNATURE_TOLERANCE_SECONDS));
  if (config.GENERIC_WEBHOOK_SECRET) sources.push(genericSource(config.GENERIC_WEBHOOK_SECRET, config.SIGNATURE_TOLERANCE_SECONDS));
  if (sources.length === 0) log.warn("no webhook secrets configured; every inbound webhook will get 404");

  const connectors = connectorsFromConfig(config);
  if (connectors.length === 0) log.warn("no connectors configured; events are stored but not delivered");

  const queue = new DeliveryQueue(pool, config.WORKER_LEASE_SECONDS);
  const metrics = createMetrics(queue, { defaultMetrics: true });
  const worker = new Worker(queue, connectors, log, metrics, {
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
    backoff: { baseMs: config.BACKOFF_BASE_MS, maxMs: config.BACKOFF_MAX_MS },
  });

  let shuttingDown = false;
  const app = createApp({
    pool,
    queue,
    sources,
    connectors,
    metrics,
    log,
    maxAttempts: config.MAX_ATTEMPTS,
    dashboardAuth:
      config.DASHBOARD_USER && config.DASHBOARD_PASSWORD
        ? { username: config.DASHBOARD_USER, password: config.DASHBOARD_PASSWORD }
        : undefined,
    onIngested: () => worker.poke(),
    isShuttingDown: () => shuttingDown,
    workerRunning: () => worker.isRunning,
  });

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
    log.info({ port: info.port, sources: sources.map((s) => s.name), connectors: connectors.map((c) => c.name) }, "listening"),
  );
  if (config.WORKER_ENABLED) worker.start();

  // Graceful shutdown: stop taking requests, let in-flight deliveries finish,
  // then close the pool. Anything still running after the timeout keeps its
  // `running` row and is re-claimed after the lease expires.
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    const hardExit = setTimeout(() => {
      log.error("shutdown took too long, exiting");
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS + 5_000).unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker.stop(config.SHUTDOWN_TIMEOUT_MS);
    await pool.end();
    clearTimeout(hardExit);
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
