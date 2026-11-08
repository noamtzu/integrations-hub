import { describe, expect, it } from "vitest";
import type { Connector, HubEvent } from "../../src/connectors/types.js";
import { ingestEvent } from "../../src/ingest/ingest.js";
import { createMetrics } from "../../src/metrics.js";
import { PermanentError, RetryableError } from "../../src/queue/errors.js";
import { DeliveryQueue } from "../../src/queue/queue.js";
import { Worker } from "../../src/queue/worker.js";
import { makeRunnable, useTestDatabase } from "../helpers/db.js";
import { silentLog, stripeEvent } from "../helpers/fixtures.js";

const db = useTestDatabase();

/** A connector that runs a script of outcomes, one per call. */
function scripted(name: string, script: Array<"ok" | "retry" | "permanent" | Error>, ratePerSecond = 1000) {
  const calls: Array<{ event: HubEvent; attempt: number; key: string }> = [];
  const connector: Connector = {
    name,
    ratePerSecond,
    accepts: () => true,
    async deliver(event, ctx) {
      calls.push({ event, attempt: ctx.attempt, key: ctx.idempotencyKey });
      const step = script.length > 1 ? script.shift()! : script[0]!;
      if (step === "retry") throw new RetryableError("503 Service Unavailable");
      if (step === "permanent") throw new PermanentError("400 Bad Request");
      if (step instanceof Error) throw step;
    },
  };
  return { connector, calls };
}

async function seed(connectors: string[], n = 1, maxAttempts = 5) {
  for (let i = 0; i < n; i++) {
    await ingestEvent(
      db.pool(),
      { source: "stripe", externalId: `evt_${i}`, type: "invoice.paid", payload: stripeEvent(`evt_${i}`, "invoice.paid") },
      connectors,
      maxAttempts,
    );
  }
}

function worker(connectors: Connector[], over: Partial<ConstructorParameters<typeof Worker>[4]> = {}) {
  const queue = new DeliveryQueue(db.pool(), 30);
  const metrics = createMetrics(queue);
  const w = new Worker(queue, connectors, silentLog, metrics, {
    concurrency: 10,
    pollIntervalMs: 20,
    backoff: { baseMs: 1000, maxMs: 60_000, random: () => 0 },
    workerId: "test-worker",
    ...over,
  });
  return { w, queue, metrics };
}

async function settle(w: Worker) {
  while (w.inFlightCount > 0) await new Promise((r) => setTimeout(r, 5));
}

/** Drives the worker by hand: one tick, wait for jobs, make retries due, repeat. */
async function drive(w: Worker, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    await w.tick();
    await settle(w);
    await makeRunnable(db.pool());
  }
}

async function delivery() {
  const { rows } = await db.pool().query("SELECT status, attempts, last_error, run_at FROM deliveries");
  return rows[0] as { status: string; attempts: number; last_error: string | null; run_at: Date };
}

describe("Worker", () => {
  it("retries a failing delivery until it succeeds, with the same idempotency key every time", async () => {
    const { connector, calls } = scripted("crm", ["retry", "retry", "ok"]);
    await seed(["crm"]);
    const { w, metrics } = worker([connector]);
    await drive(w, 4);

    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(new Set(calls.map((c) => c.key)).size).toBe(1);
    expect(await delivery()).toMatchObject({ status: "succeeded", attempts: 3, last_error: null });
    const m = await metrics.registry.getSingleMetricAsString("hub_delivery_attempts_total");
    expect(m).toContain('connector="crm",outcome="retry"} 2');
    expect(m).toContain('connector="crm",outcome="succeeded"} 1');
  });

  it("waits an exponentially growing delay between attempts", async () => {
    const { connector } = scripted("crm", ["retry"]);
    await seed(["crm"]);
    const { w } = worker([connector]);
  
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await w.tick();
      await settle(w);
      delays.push((await delivery()).run_at.getTime() - t);
      await makeRunnable(db.pool());
    }
    // random() = 0 -> half the window: 500ms, 1s, 2s
    expect(delays[0]).toBeGreaterThanOrEqual(400);
    expect(delays[0]).toBeLessThan(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(900);
    expect(delays[1]).toBeLessThan(1600);
    expect(delays[2]).toBeGreaterThanOrEqual(1900);
    expect(delays[2]).toBeLessThan(2600);
  });

  it("honours Retry-After when it is longer than the backoff", async () => {
    const connector: Connector = {
      name: "crm",
      ratePerSecond: 100,
      accepts: () => true,
      deliver: async () => {
        throw new RetryableError("429", 120_000);
      },
    };
    await seed(["crm"]);
    const { w } = worker([connector]);
      const t = Date.now();
    await w.tick();
    await settle(w);
    const wait = (await delivery()).run_at.getTime() - t;
    expect(wait).toBeGreaterThan(115_000); // backoff alone would be ~500ms
    expect(wait).toBeLessThan(125_000);
  });

  it("dead-letters after max attempts and succeeds after a replay", async () => {
    const { connector, calls } = scripted("crm", ["retry", "retry", "retry", "ok"]);
    await seed(["crm"], 1, 3);
    const { w, queue } = worker([connector]);
    await drive(w, 5);

    const dead = await delivery();
    expect(dead).toMatchObject({ status: "dead", attempts: 3 });
    expect(dead.last_error).toContain("503");

    const { rows } = await db.pool().query<{ id: number }>("SELECT id FROM deliveries");
    expect(await queue.replay(rows[0]!.id)).toBe(true);
    await drive(w, 1);
    expect(await delivery()).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(calls).toHaveLength(4);
  });

  it("does not retry permanent errors", async () => {
    const { connector, calls } = scripted("crm", ["permanent"]);
    await seed(["crm"]);
    const { w } = worker([connector]);
    await drive(w, 3);
    expect(calls).toHaveLength(1);
    expect(await delivery()).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("treats unknown errors as retryable", async () => {
    const { connector } = scripted("crm", [new TypeError("cannot read properties of undefined"), "ok"]);
    await seed(["crm"]);
    const { w } = worker([connector]);
    await drive(w, 2);
    expect(await delivery()).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("isolates connectors: one failing destination does not block another", async () => {
    const bad = scripted("crm", ["permanent"]);
    const good = scripted("sheets", ["ok"]);
    await seed(["crm", "sheets"], 3);
    const { w } = worker([bad.connector, good.connector]);
    await drive(w, 1);
    const { rows } = await db.pool().query(
      "SELECT connector, status, count(*)::int AS n FROM deliveries GROUP BY 1, 2 ORDER BY 1",
    );
    expect(rows).toEqual([
      { connector: "crm", status: "dead", n: 3 },
      { connector: "sheets", status: "succeeded", n: 3 },
    ]);
  });

  it("rate limits per connector", async () => {
    const slow = scripted("sheets", ["ok"], 2); // burst of 2, then 2/s
    const fast = scripted("crm", ["ok"], 1000);
    await seed(["sheets", "crm"], 6);
    const { w } = worker([slow.connector, fast.connector]);
    await drive(w, 1);

    expect(slow.calls).toHaveLength(2);
    expect(fast.calls).toHaveLength(6);
    const { rows } = await db.pool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM deliveries WHERE connector = 'sheets' AND status = 'pending' AND attempts = 0",
    );
    expect(rows[0]!.n).toBe(4); // untouched: never claimed, attempts not spent
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const connector: Connector = {
      name: "crm",
      ratePerSecond: 1000,
      accepts: () => true,
      async deliver() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      },
    };
    await seed(["crm"], 12);
    const { w } = worker([connector], { concurrency: 3 });
    w.start();
    await expect.poll(async () => (await db.pool().query("SELECT 1 FROM deliveries WHERE status='succeeded'")).rowCount, { timeout: 5000 }).toBe(12);
    await w.stop(1000);
    expect(peak).toBe(3);
  });

  it("graceful stop waits for in-flight deliveries to finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const connector: Connector = { name: "crm", ratePerSecond: 100, accepts: () => true, deliver: () => gate };
    await seed(["crm"]);
    const { w } = worker([connector]);
    w.start();
    await expect.poll(() => w.inFlightCount).toBe(1);

    const stopped = w.stop(5000);
    setTimeout(release, 50);
    await stopped;
    expect(await delivery()).toMatchObject({ status: "succeeded" });
  });

  it("on shutdown timeout, aborts in-flight work and leaves it for lease recovery", async () => {
    const connector: Connector = {
      name: "crm",
      ratePerSecond: 100,
      accepts: () => true,
      deliver: (_e, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new RetryableError("aborted by shutdown")));
        }),
    };
    await seed(["crm"]);
    const { w } = worker([connector]);
    w.start();
    await expect.poll(() => w.inFlightCount).toBe(1);
    await w.stop(50);
    // The abort surfaced as a retryable failure, so the job is scheduled again, not lost.
    expect(await delivery()).toMatchObject({ status: "pending", attempts: 1 });
  });
});
