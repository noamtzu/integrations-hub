import { describe, expect, it } from "vitest";
import { BadPayloadError, genericSource, stripeSource } from "../../src/ingest/sources.js";
import { deliveryIdempotencyKey } from "../../src/ingest/ingest.js";

describe("sources.extract", () => {
  const h = (init: Record<string, string> = {}) => new Headers(init);

  it("stripe uses the event id and type", () => {
    const s = stripeSource("x", 300);
    expect(s.extract({ id: "evt_9", type: "invoice.paid" }, h(), "")).toEqual({ externalId: "evt_9", type: "invoice.paid" });
    expect(() => s.extract({ type: "invoice.paid" }, h(), "")).toThrow(BadPayloadError);
  });

  it("generic prefers Idempotency-Key, then body id, then a body hash", () => {
    const s = genericSource("x", 300);
    expect(s.extract({ id: 7 }, h({ "idempotency-key": "k1" }), "{}").externalId).toBe("k1");
    expect(s.extract({ id: 7, type: "order.created" }, h(), "{}")).toEqual({ externalId: "7", type: "order.created" });
    const a = s.extract({ x: 1 }, h(), '{"x":1}').externalId;
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(s.extract({ x: 1 }, h(), '{"x":1}').externalId).toBe(a);
    expect(() => s.extract([1, 2], h(), "[1,2]")).toThrow(BadPayloadError);
  });
});

describe("deliveryIdempotencyKey", () => {
  it("is stable per (connector, event) and differs across connectors", () => {
    const k = deliveryIdempotencyKey("webhook", "stripe", "evt_1");
    expect(deliveryIdempotencyKey("webhook", "stripe", "evt_1")).toBe(k);
    expect(deliveryIdempotencyKey("google-sheets", "stripe", "evt_1")).not.toBe(k);
  });
});
