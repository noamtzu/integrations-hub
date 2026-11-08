import { describe, expect, it } from "vitest";
import type { Connector } from "../../src/connectors/types.js";
import { createApp, type AppDeps } from "../../src/http/app.js";
import { ingestEvent } from "../../src/ingest/ingest.js";
import { stripeSource } from "../../src/ingest/sources.js";
import { createMetrics } from "../../src/metrics.js";
import { DeliveryQueue } from "../../src/queue/queue.js";
import { useTestDatabase } from "../helpers/db.js";
import { STRIPE_SECRET, silentLog, stripeEvent } from "../helpers/fixtures.js";

const db = useTestDatabase();

const crm: Connector = { name: "crm", ratePerSecond: 10, accepts: () => true, deliver: async () => undefined };

function app(over: Partial<AppDeps> = {}) {
  const pool = db.pool();
  const queue = new DeliveryQueue(pool, 30);
  return {
    queue,
    app: createApp({
      pool,
      queue,
      sources: [stripeSource(STRIPE_SECRET, 300)],
      connectors: [crm],
      metrics: createMetrics(queue),
      log: silentLog,
      maxAttempts: 1,
      ...over,
    }),
  };
}

/** Seeds one event whose delivery is dead, and returns the delivery id. */
async function deadDelivery(queue: DeliveryQueue, externalId = "evt_dead"): Promise<number> {
  await ingestEvent(db.pool(), { source: "stripe", externalId, type: "customer.created", payload: stripeEvent(externalId) }, ["crm"], 1);
  const [job] = await queue.claim("crm", 1, "w");
  await queue.fail(job!, "w", "PermanentError: webhook destination responded 422: <script>alert(1)</script>", {
    permanent: true,
    retryInMs: 0,
    durationMs: 12,
  });
  return job!.id;
}

describe("GET /health", () => {
  it("reports ok when the database answers", async () => {
    const res = await app({ workerRunning: () => true }).app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", db: "ok", worker: true, connectors: ["crm"] });
  });

  it("returns 503 while shutting down so the load balancer drains traffic", async () => {
    const res = await app({ isShuttingDown: () => true }).app.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "shutting_down" });
  });
});

describe("GET /metrics", () => {
  it("exposes Prometheus text including queue depth from Postgres", async () => {
    const { app: a, queue } = app();
    await deadDelivery(queue);
    const res = await a.request("/metrics");
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain('hub_deliveries{connector="crm",status="dead"} 1');
    expect(text).toContain("# TYPE hub_delivery_duration_seconds histogram");
  });
});

describe("dashboard", () => {
  it("lists recent events and dead deliveries, escaping error text", async () => {
    const { app: a, queue } = app();
    await deadDelivery(queue);
    const res = await a.request("/dashboard");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Dead-letter list (1)");
    expect(page).toContain("evt_dead");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<script>alert(1)</script>");
  });

  it("shows the attempt history on the event page", async () => {
    const { app: a, queue } = app();
    await deadDelivery(queue);
    const page = await (await a.request("/dashboard/events/1")).text();
    expect(page).toContain("attempt 1/1");
    expect(page).toContain("12 ms");
    expect((await a.request("/dashboard/events/999")).status).toBe(404);
  });

  it("the Replay button requeues a dead delivery and redirects back", async () => {
    let poked = 0;
    const { app: a, queue } = app({ onIngested: () => poked++ });
    const id = await deadDelivery(queue);
    const res = await a.request(`/dashboard/deliveries/${id}/replay`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(poked).toBe(1);
    const { rows } = await db.pool().query("SELECT status, attempts FROM deliveries");
    expect(rows).toEqual([{ status: "pending", attempts: 0 }]);
  });

  it("blocks cross-site form posts (CSRF)", async () => {
    const { app: a, queue } = app();
    const id = await deadDelivery(queue);
    const res = await a.request(`http://localhost/dashboard/deliveries/${id}/replay`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("requires basic auth when configured", async () => {
    const { app: a } = app({ dashboardAuth: { username: "ops", password: "pw" } });
    expect((await a.request("/dashboard")).status).toBe(401);
    expect((await a.request("/api/deliveries")).status).toBe(401);
    const ok = await a.request("/dashboard", { headers: { authorization: `Basic ${btoa("ops:pw")}` } });
    expect(ok.status).toBe(200);
    expect((await a.request("/health")).status).toBe(200); // probes stay open
  });
});

describe("JSON API", () => {
  it("lists deliveries by status and replays via POST", async () => {
    const { app: a, queue } = app();
    const id = await deadDelivery(queue);
    const list = (await (await a.request("/api/deliveries?status=dead")).json()) as { deliveries: Array<{ id: number }> };
    expect(list.deliveries.map((d) => d.id)).toEqual([id]);

    expect((await a.request(`/api/deliveries/${id}/replay`, { method: "POST" })).status).toBe(200);
    expect((await a.request(`/api/deliveries/${id}/replay`, { method: "POST" })).status).toBe(409);
  });
});
