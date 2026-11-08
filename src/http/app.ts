import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import type { Connector } from "../connectors/types.js";
import type { Pool } from "../db/pool.js";
import { ingestEvent } from "../ingest/ingest.js";
import { BadPayloadError, type Source } from "../ingest/sources.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { DeliveryQueue } from "../queue/queue.js";
import { renderEvent, renderOverview } from "./dashboard.js";

export interface AppDeps {
  pool: Pool;
  queue: DeliveryQueue;
  sources: Source[];
  connectors: Connector[];
  metrics: Metrics;
  log: Logger;
  maxAttempts: number;
  dashboardAuth?: { username: string; password: string };
  /** Called after an event is stored, so the worker can pick it up without waiting for the next poll. */
  onIngested?: () => void;
  /** Reported by /health; the process flips it on SIGTERM so load balancers stop sending traffic. */
  isShuttingDown?: () => boolean;
  workerRunning?: () => boolean;
  /** Seconds since epoch; injectable for signature tests. */
  now?: () => number;
}

type Env = { Variables: { log: Logger; requestId: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const sources = new Map(deps.sources.map((s) => [s.name, s]));

  // Request id + one structured log line per request.
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    const log = deps.log.child({ requestId });
    c.set("requestId", requestId);
    c.set("log", log);
    const start = performance.now();
    await next();
    c.header("x-request-id", requestId);
    if (c.req.path !== "/health" && c.req.path !== "/metrics") {
      log.info(
        { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - start) },
        "request",
      );
    }
  });

  app.onError((err, c) => {
    // Middleware rejections (401 auth, 403 CSRF, 413 body size) carry their own response.
    if (err instanceof HTTPException) return err.getResponse();
    c.get("log").error({ err }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });

  // ---- Inbound webhooks -------------------------------------------------
  app.post("/webhooks/:source", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const source = sources.get(c.req.param("source"));
    if (!source) return c.json({ error: "unknown source" }, 404);
    const log = c.get("log").child({ source: source.name });
    const reject = (status: 400 | 401, error: string) => {
      deps.metrics.webhooksReceived.inc({ source: source.name, result: "rejected" });
      log.warn({ reason: error }, "webhook rejected");
      return c.json({ error }, status);
    };

    // Verify against the exact bytes received, before parsing anything.
    const rawBody = await c.req.text();
    const verified = source.verify(rawBody, c.req.raw.headers, deps.now?.());
    if (!verified.ok) return reject(401, `invalid signature: ${verified.reason}`);

    let body: unknown;
    let meta: { externalId: string; type: string };
    try {
      body = JSON.parse(rawBody);
      meta = source.extract(body, c.req.raw.headers, rawBody);
    } catch (err) {
      return reject(400, err instanceof BadPayloadError ? err.message : "body is not valid JSON");
    }

    const targets = deps.connectors.filter((k) => k.accepts({ source: source.name, type: meta.type })).map((k) => k.name);
    const result = await ingestEvent(
      deps.pool,
      { source: source.name, externalId: meta.externalId, type: meta.type, payload: body },
      targets,
      deps.maxAttempts,
    );
    deps.metrics.webhooksReceived.inc({ source: source.name, result: result.duplicate ? "duplicate" : "accepted" });
    log.info({ externalId: meta.externalId, type: meta.type, ...result }, "webhook accepted");
    if (!result.duplicate && result.deliveries > 0) deps.onIngested?.();
    // 200 for duplicates too: the provider must stop retrying an event we already have.
    return c.json({ received: true, eventId: result.eventId, duplicate: result.duplicate });
  });

  // ---- Operations -------------------------------------------------------
  app.get("/health", async (c) => {
    let db = "ok";
    try {
      await deps.pool.query("SELECT 1");
    } catch {
      db = "unreachable";
    }
    const shuttingDown = deps.isShuttingDown?.() ?? false;
    const healthy = db === "ok" && !shuttingDown;
    return c.json(
      {
        status: healthy ? "ok" : shuttingDown ? "shutting_down" : "degraded",
        db,
        worker: deps.workerRunning?.() ?? false,
        connectors: deps.connectors.map((k) => k.name),
        uptimeSeconds: Math.round(process.uptime()),
      },
      healthy ? 200 : 503,
    );
  });

  app.get("/metrics", async (c) => {
    c.header("content-type", deps.metrics.registry.contentType);
    return c.body(await deps.metrics.registry.metrics());
  });

  // ---- Dashboard + JSON API --------------------------------------------
  if (deps.dashboardAuth) {
    app.use("/dashboard/*", basicAuth(deps.dashboardAuth));
    app.use("/api/*", basicAuth(deps.dashboardAuth));
  }
  app.use("/dashboard/*", csrf());

  app.get("/", (c) => c.redirect("/dashboard"));
  app.get("/dashboard", async (c) => c.html(await renderOverview(deps.pool)));
  app.get("/dashboard/events/:id{[0-9]+}", async (c) => {
    const page = await renderEvent(deps.pool, Number(c.req.param("id")));
    return page ? c.html(page) : c.text("event not found", 404);
  });

  const replayOne = async (c: Context<Env>) => {
    const id = Number(c.req.param("id"));
    const ok = await deps.queue.replay(id);
    c.get("log").info({ deliveryId: id, ok }, "replay requested");
    if (ok) deps.onIngested?.();
    return ok;
  };

  app.post("/dashboard/deliveries/:id{[0-9]+}/replay", async (c) => {
    await replayOne(c);
    return c.redirect(c.req.header("referer") ?? "/dashboard", 303);
  });
  app.post("/dashboard/replay-dead", async (c) => {
    const n = await deps.queue.replayAllDead();
    c.get("log").info({ count: n }, "replay all requested");
    if (n > 0) deps.onIngested?.();
    return c.redirect("/dashboard", 303);
  });

  app.get("/api/deliveries", async (c) => {
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 500);
    const { rows } = await deps.pool.query(
      `SELECT d.id, d.event_id, d.connector, d.status, d.attempts, d.max_attempts, d.run_at, d.last_error,
              d.updated_at, e.source, e.external_id, e.type
         FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE ($1::text IS NULL OR d.status = $1)
        ORDER BY d.updated_at DESC LIMIT $2`,
      [status ?? null, limit],
    );
    return c.json({ deliveries: rows });
  });
  app.post("/api/deliveries/:id{[0-9]+}/replay", async (c) => {
    const ok = await replayOne(c);
    return ok ? c.json({ replayed: true }) : c.json({ error: "delivery not found or not dead" }, 409);
  });

  return app;
}
