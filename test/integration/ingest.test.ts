import { describe, expect, it } from "vitest";
import type { Connector } from "../../src/connectors/types.js";
import { createApp } from "../../src/http/app.js";
import { genericSource, stripeSource } from "../../src/ingest/sources.js";
import { createMetrics } from "../../src/metrics.js";
import { DeliveryQueue } from "../../src/queue/queue.js";
import { useTestDatabase } from "../helpers/db.js";
import {
  GENERIC_SECRET,
  STRIPE_SECRET,
  signGeneric,
  signStripe,
  silentLog,
  stripeEvent,
} from "../helpers/fixtures.js";

const db = useTestDatabase();

const noop = (name: string, accepts: Connector["accepts"] = () => true): Connector => ({
  name,
  ratePerSecond: 100,
  accepts,
  deliver: async () => undefined,
});

function app(connectors: Connector[] = [noop("sheets"), noop("crm", (e) => e.type.startsWith("customer."))]) {
  const pool = db.pool();
  const metrics = createMetrics();
  return {
    metrics,
    app: createApp({
      pool,
      queue: new DeliveryQueue(pool, 30),
      sources: [stripeSource(STRIPE_SECRET, 300), genericSource(GENERIC_SECRET, 300)],
      connectors,
      metrics,
      log: silentLog,
      maxAttempts: 5,
    }),
  };
}

const postStripe = async (a: ReturnType<typeof app>["app"], body: string, signature = signStripe(body)) =>
  a.request("/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body,
  });

async function count(table: string): Promise<number> {
  const { rows } = await db.pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe("POST /webhooks/stripe", () => {
  it("stores the event and one delivery per matching connector", async () => {
    const { app: a } = app();
    const res = await postStripe(a, JSON.stringify(stripeEvent("evt_A")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, duplicate: false });

    const { rows } = await db.pool().query("SELECT connector, status, attempts FROM deliveries");
    expect(rows).toEqual([{ connector: "sheets", status: "pending", attempts: 0 }]);
  });

  it("is idempotent: a redelivered event is acknowledged but stored once", async () => {
    const { app: a, metrics } = app();
    const body = JSON.stringify(stripeEvent("evt_DUP"));
    const first = await postStripe(a, body);
    const second = await postStripe(a, body);
    const third = await postStripe(a, body);

    expect(first.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(third.status).toBe(200);
    expect(await count("events")).toBe(1);
    expect(await count("deliveries")).toBe(1);
    expect(await metrics.registry.getSingleMetricAsString("hub_webhooks_received_total")).toContain(
      'hub_webhooks_received_total{source="stripe",result="duplicate"} 2',
    );
  });

  it("dedupes concurrent deliveries of the same event", async () => {
    const { app: a } = app();
    const body = JSON.stringify(stripeEvent("evt_RACE"));
    const results = await Promise.all(Array.from({ length: 10 }, () => postStripe(a, body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await count("events")).toBe(1);
    expect(await count("deliveries")).toBe(1);
  });

  it("rejects a bad signature with 401 and stores nothing", async () => {
    const { app: a, metrics } = app();
    const body = JSON.stringify(stripeEvent("evt_BAD"));
    const res = await postStripe(a, body, signStripe(body, "whsec_attacker"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature: signature mismatch" });
    expect(await count("events")).toBe(0);
    expect(await metrics.registry.getSingleMetricAsString("hub_webhooks_received_total")).toContain('result="rejected"} 1');
  });

  it("rejects a body modified after signing", async () => {
    const { app: a } = app();
    const body = JSON.stringify(stripeEvent("evt_T"));
    const res = await postStripe(a, body.replace("4900", "1"), signStripe(body));
    expect(res.status).toBe(401);
    expect(await count("events")).toBe(0);
  });

  it("rejects a replayed request with an old timestamp", async () => {
    const { app: a } = app();
    const body = JSON.stringify(stripeEvent("evt_OLD"));
    const res = await postStripe(a, body, signStripe(body, STRIPE_SECRET, Math.floor(Date.now() / 1000) - 3600));
    expect(res.status).toBe(401);
  });

  it("returns 400 for a signed body that is not a Stripe event", async () => {
    const { app: a } = app();
    const res = await postStripe(a, JSON.stringify({ hello: "world" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown source", async () => {
    const { app: a } = app();
    const res = await a.request("/webhooks/nope", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("rejects bodies over 1 MB", async () => {
    const { app: a } = app();
    const res = await postStripe(a, JSON.stringify({ id: "evt_big", type: "x", pad: "a".repeat(1_100_000) }));
    expect(res.status).toBe(413);
  });
});

describe("POST /webhooks/generic", () => {
  it("accepts a signed event and dedupes by Idempotency-Key", async () => {
    const { app: a } = app();
    const send = (body: string) =>
      a.request("/webhooks/generic", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "order-77", ...signGeneric(body) },
        body,
      });
    expect((await send(JSON.stringify({ type: "order.created", n: 1 }))).status).toBe(200);
    // Different bytes, same key: still one event.
    expect(await (await send(JSON.stringify({ type: "order.created", n: 2 }))).json()).toMatchObject({ duplicate: true });
    expect(await count("events")).toBe(1);
  });

  it("rejects a missing signature", async () => {
    const { app: a } = app();
    const res = await a.request("/webhooks/generic", { method: "POST", body: JSON.stringify({ id: 1 }) });
    expect(res.status).toBe(401);
  });
});
