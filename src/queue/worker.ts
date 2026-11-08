import { randomUUID } from "node:crypto";
import { TokenBucket } from "../lib/token-bucket.js";
import type { Connector } from "../connectors/types.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import { backoffDelay } from "./backoff.js";
import { PermanentError, RetryableError, errorMessage } from "./errors.js";
import type { ClaimedDelivery, DeliveryQueue } from "./queue.js";

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs: number;
  backoff: { baseMs: number; maxMs: number; random?: () => number };
  workerId?: string;
}

/**
 * Pulls jobs from the queue and runs them through connectors.
 *
 * Each connector has its own token bucket, and the worker only claims as many
 * jobs as that bucket allows. Rows are never claimed and then left waiting for a
 * token, so a slow destination cannot hold jobs that other workers could run.
 */
export class Worker {
  readonly id: string;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly queue: DeliveryQueue,
    private readonly connectors: Connector[],
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly opts: WorkerOptions,
  ) {
    this.id = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    for (const c of connectors) this.buckets.set(c.name, new TokenBucket(c.ratePerSecond));
  }

  get isRunning(): boolean {
    return this.running;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.log.info({ workerId: this.id, connectors: this.connectors.map((c) => c.name) }, "worker started");
  }

  /** Nudges the loop to poll now (e.g. right after ingest) instead of waiting for the next tick. */
  poke(): void {
    this.wake?.();
  }

  /**
   * Stops claiming new jobs and waits for in-flight ones. After `timeoutMs` the
   * remaining deliveries are aborted; their rows stay `running` and are picked
   * up again when the lease expires, so nothing is lost.
   */
  async stop(timeoutMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;

    const drained = Promise.allSettled([...this.inFlight]).then(() => true);
    const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
    if (!(await Promise.race([drained, timedOut]))) {
      this.log.warn({ inFlight: this.inFlight.size }, "shutdown timeout, aborting in-flight deliveries");
      this.abort.abort();
      await Promise.allSettled([...this.inFlight]);
    }
    this.log.info({ workerId: this.id }, "worker stopped");
  }

  /** One polling pass. Public so tests can drive the worker step by step. */
  async tick(): Promise<number> {
    let started = 0;
    for (const connector of this.connectors) {
      const free = this.opts.concurrency - this.inFlight.size;
      if (free <= 0) break;
      const bucket = this.buckets.get(connector.name)!;
      const allowed = Math.min(free, bucket.available());
      if (allowed <= 0) continue;

      const jobs = await this.queue.claim(connector.name, allowed, this.id);
      bucket.take(jobs.length);
      for (const job of jobs) {
        const p = this.execute(connector, job).finally(() => {
          this.inFlight.delete(p);
          this.wake?.();
        });
        this.inFlight.add(p);
        started++;
      }
    }
    return started;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let started = 0;
      try {
        started = await this.tick();
      } catch (err) {
        this.log.error({ err }, "worker poll failed");
      }
      if (!this.running) break;
      // Poll again at once if we found work and have room, otherwise sleep.
      if (started > 0 && this.inFlight.size < this.opts.concurrency) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.pollIntervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  private async execute(connector: Connector, job: ClaimedDelivery): Promise<void> {
    const log = this.log.child({
      deliveryId: job.id,
      eventId: job.eventId,
      connector: connector.name,
      attempt: job.attempts,
    });
    const started = performance.now();
    try {
      await connector.deliver(job.event, {
        idempotencyKey: job.idempotencyKey,
        attempt: job.attempts,
        log,
        signal: this.abort.signal,
      });
      const durationMs = Math.round(performance.now() - started);
      this.metrics.deliveryDuration.observe({ connector: connector.name }, durationMs / 1000);
      if (await this.queue.complete(job, this.id, durationMs)) {
        this.metrics.deliveryAttempts.inc({ connector: connector.name, outcome: "succeeded" });
        log.info({ durationMs }, "delivered");
      } else {
        log.warn("delivered, but the lease was lost; another worker owns this job now");
      }
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      this.metrics.deliveryDuration.observe({ connector: connector.name }, durationMs / 1000);
      const permanent = err instanceof PermanentError;
      const backoff = backoffDelay(job.attempts, this.opts.backoff);
      const retryInMs = Math.max(backoff, err instanceof RetryableError ? (err.retryAfterMs ?? 0) : 0);
      try {
        const result = await this.queue.fail(job, this.id, errorMessage(err), { permanent, retryInMs, durationMs });
        if (!result) {
          log.warn({ err }, "failed, and the lease was lost");
          return;
        }
        this.metrics.deliveryAttempts.inc({ connector: connector.name, outcome: result.outcome });
        if (result.outcome === "dead") {
          log.error({ err: errorMessage(err), permanent }, "delivery moved to dead-letter list");
        } else {
          log.warn({ err: errorMessage(err), retryInMs, runAt: result.runAt }, "delivery failed, will retry");
        }
      } catch (dbErr) {
        // The row stays `running`; lease expiry will hand it to a worker again.
        log.error({ err: dbErr }, "could not record failure");
      }
    }
  }
}
