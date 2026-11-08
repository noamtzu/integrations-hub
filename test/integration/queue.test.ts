import { describe, expect, it } from "vitest";
import { ingestEvent } from "../../src/ingest/ingest.js";
import { DeliveryQueue } from "../../src/queue/queue.js";
import { makeRunnable, useTestDatabase } from "../helpers/db.js";
import { stripeEvent } from "../helpers/fixtures.js";

const db = useTestDatabase();

async function seed(n: number, connector = "crm", maxAttempts = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    await ingestEvent(
      db.pool(),
      { source: "stripe", externalId: `evt_${i}`, type: "customer.created", payload: stripeEvent(`evt_${i}`) },
      [connector],
      maxAttempts,
    );
  }
}

const opts = (over: Partial<{ permanent: boolean; retryInMs: number }> = {}) => ({
  permanent: false,
  retryInMs: 60_000,
  durationMs: 5,
  ...over,
});

describe("DeliveryQueue", () => {
  it("claims with SKIP LOCKED: concurrent workers never get the same job", async () => {
    await seed(50);
    const queue = new DeliveryQueue(db.pool(), 30);
    const batches = await Promise.all(
      Array.from({ length: 8 }, (_, i) => queue.claim("crm", 10, `w${i}`)),
    );
    const ids = batches.flat().map((j) => j.id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  });

  it("only claims jobs for the requested connector", async () => {
    await seed(2, "crm");
    const queue = new DeliveryQueue(db.pool(), 30);
    expect(await queue.claim("sheets", 10, "w")).toHaveLength(0);
    expect(await queue.claim("crm", 10, "w")).toHaveLength(2);
  });

  it("returns the event with the job", async () => {
    await seed(1);
    const [job] = await new DeliveryQueue(db.pool(), 30).claim("crm", 1, "w");
    expect(job).toMatchObject({ attempts: 1, maxAttempts: 3, event: { source: "stripe", externalId: "evt_0", type: "customer.created" } });
    expect(job!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("schedules a retry with the given delay and does not hand the job out early", async () => {
    await seed(1);
    const queue = new DeliveryQueue(db.pool(), 30);
    const [job] = await queue.claim("crm", 1, "w");
    const before = Date.now();
    const result = await queue.fail(job!, "w", "503 from destination", opts({ retryInMs: 60_000 }));

    expect(result?.outcome).toBe("retry");
    const runAt = (result as { runAt: Date }).runAt.getTime();
    expect(runAt - before).toBeGreaterThan(55_000);
    expect(runAt - before).toBeLessThan(65_000);
    expect(await queue.claim("crm", 1, "w")).toHaveLength(0);

    await makeRunnable(db.pool());
    const [again] = await queue.claim("crm", 1, "w");
    expect(again!.attempts).toBe(2);
  });

  it("moves a job to dead-letter after max attempts, keeping each attempt in the audit trail", async () => {
    await seed(1, "crm", 3);
    const queue = new DeliveryQueue(db.pool(), 30);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      await makeRunnable(db.pool());
      const [job] = await queue.claim("crm", 1, "w");
      outcomes.push((await queue.fail(job!, "w", `failure ${i + 1}`, opts()))!.outcome);
    }
    expect(outcomes).toEqual(["retry", "retry", "dead"]);

    const { rows } = await db.pool().query("SELECT status, attempts, last_error FROM deliveries");
    expect(rows).toEqual([{ status: "dead", attempts: 3, last_error: "failure 3" }]);
    const audit = await db.pool().query("SELECT attempt, outcome FROM delivery_attempts ORDER BY attempt");
    expect(audit.rows).toEqual([
      { attempt: 1, outcome: "retry" },
      { attempt: 2, outcome: "retry" },
      { attempt: 3, outcome: "dead" },
    ]);
  });

  it("sends permanent failures straight to dead-letter", async () => {
    await seed(1, "crm", 10);
    const queue = new DeliveryQueue(db.pool(), 30);
    const [job] = await queue.claim("crm", 1, "w");
    expect(await queue.fail(job!, "w", "422 invalid email", opts({ permanent: true }))).toEqual({ outcome: "dead" });
  });

  it("replays a dead job with a fresh attempt budget, and only dead jobs", async () => {
    await seed(1, "crm", 1);
    const queue = new DeliveryQueue(db.pool(), 30);
    const [job] = await queue.claim("crm", 1, "w");
    expect(await queue.replay(job!.id)).toBe(false); // running, not dead
    await queue.fail(job!, "w", "boom", opts());

    expect(await queue.replay(job!.id)).toBe(true);
    expect(await queue.replay(job!.id)).toBe(false); // second click is a no-op
    const [again] = await queue.claim("crm", 1, "w");
    expect(again).toMatchObject({ id: job!.id, attempts: 1 });
    expect(await queue.complete(again!, "w", 3)).toBe(true);

    const { rows } = await db.pool().query("SELECT status, last_error FROM deliveries");
    expect(rows).toEqual([{ status: "succeeded", last_error: null }]);
  });

  it("replays all dead jobs for one connector", async () => {
    await seed(3, "crm", 1);
    await seed(0);
    const queue = new DeliveryQueue(db.pool(), 30);
    for (const job of await queue.claim("crm", 10, "w")) await queue.fail(job, "w", "x", opts());
    expect(await queue.replayAllDead("sheets")).toBe(0);
    expect(await queue.replayAllDead("crm")).toBe(3);
  });

  it("re-claims a job whose worker died (lease expired)", async () => {
    await seed(1);
    const queue = new DeliveryQueue(db.pool(), 30);
    const [job] = await queue.claim("crm", 1, "crashed-worker");
    expect(await queue.claim("crm", 1, "w2")).toHaveLength(0);

    await db.pool().query("UPDATE deliveries SET locked_at = now() - interval '31 seconds'");
    const [reclaimed] = await queue.claim("crm", 1, "w2");
    expect(reclaimed).toMatchObject({ id: job!.id, attempts: 2 });
  });

  it("fences stale workers: a worker that lost its lease cannot overwrite the new owner", async () => {
    await seed(1);
    const queue = new DeliveryQueue(db.pool(), 30);
    const [stale] = await queue.claim("crm", 1, "w1");
    await db.pool().query("UPDATE deliveries SET locked_at = now() - interval '31 seconds'");
    const [fresh] = await queue.claim("crm", 1, "w2");

    expect(await queue.complete(stale!, "w1", 1)).toBe(false);
    expect(await queue.fail(stale!, "w1", "late failure", opts())).toBeNull();
    expect(await queue.complete(fresh!, "w2", 1)).toBe(true);
  });

  it("reports counts by connector and status", async () => {
    await seed(2);
    const queue = new DeliveryQueue(db.pool(), 30);
    await queue.claim("crm", 1, "w");
    expect(await queue.countsByStatus()).toEqual([
      { connector: "crm", status: "pending", count: 1 },
      { connector: "crm", status: "running", count: 1 },
    ]);
  });
});
