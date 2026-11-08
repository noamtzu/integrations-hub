import { describe, expect, it } from "vitest";
import { toHubSpotContact, webhookConnector } from "../../src/connectors/webhook.js";
import { hmacSha256Hex } from "../../src/ingest/signature.js";
import { PermanentError, RetryableError } from "../../src/queue/errors.js";
import { ctx, fakeFetch, hubEvent, json } from "../helpers/fixtures.js";

const url = "https://crm.example.test/hooks/contacts";

describe("toHubSpotContact", () => {
  it("maps a Stripe checkout session to a contact upsert", () => {
    expect(toHubSpotContact(hubEvent())).toEqual({
      idProperty: "email",
      id: "jane.doe@example.com",
      properties: {
        email: "jane.doe@example.com",
        firstname: "Jane",
        lastname: "Q Doe",
        last_event_type: "checkout.session.completed",
        last_event_source: "stripe",
        last_payment_amount: "49.00",
        last_payment_currency: "USD",
      },
      context: { hubEventId: 42, sourceEventId: "evt_1", occurredAt: "2026-01-15T10:00:00.000Z" },
    });
  });

  it("maps a flat generic payload", () => {
    const out = toHubSpotContact(
      hubEvent({ source: "generic", payload: { email: "sam@example.com", name: "Sam" } }),
    ) as { properties: Record<string, unknown> };
    expect(out.properties).toMatchObject({ email: "sam@example.com", firstname: "Sam", lastname: null });
  });
});

describe("webhookConnector", () => {
  it("POSTs JSON with idempotency key, attempt number and an HMAC signature", async () => {
    const f = fakeFetch(json(200, { ok: true }));
    const connector = webhookConnector({ url, secret: "out_secret", fetch: f.fn });
    await connector.deliver(hubEvent(), ctx({ attempt: 3 }));

    expect(f.calls).toHaveLength(1);
    const { init } = f.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(f.calls[0]!.url).toBe(url);
    expect(init.method).toBe("POST");
    expect(headers["idempotency-key"]).toBe("idem-123");
    expect(headers["x-hub-attempt"]).toBe("3");
    const expected = hmacSha256Hex("out_secret", `${headers["x-hub-timestamp"]}.${init.body as string}`);
    expect(headers["x-hub-signature"]).toBe(`sha256=${expected}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ idProperty: "email" });
  });

  it("uses a custom transform when given", async () => {
    const f = fakeFetch(new Response(null, { status: 204 }));
    const connector = webhookConnector({ url, fetch: f.fn, transform: (e) => ({ t: e.type }) });
    await connector.deliver(hubEvent(), ctx());
    expect(f.calls[0]!.init.body).toBe(JSON.stringify({ t: "checkout.session.completed" }));
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-hub-signature"]).toBeUndefined();
  });

  it("treats 5xx as retryable", async () => {
    const connector = webhookConnector({ url, fetch: fakeFetch(new Response("down", { status: 503 })).fn });
    await expect(connector.deliver(hubEvent(), ctx())).rejects.toBeInstanceOf(RetryableError);
  });

  it("treats 429 as retryable and honours Retry-After", async () => {
    const res = new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    const connector = webhookConnector({ url, fetch: fakeFetch(res).fn });
    const err = await connector.deliver(hubEvent(), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryAfterMs).toBe(30_000);
  });

  it("treats other 4xx as permanent", async () => {
    const connector = webhookConnector({ url, fetch: fakeFetch(json(422, { message: "bad email" })).fn });
    await expect(connector.deliver(hubEvent(), ctx())).rejects.toThrow(PermanentError);
  });

  it("treats network errors as retryable", async () => {
    const connector = webhookConnector({ url, fetch: fakeFetch(new TypeError("fetch failed")).fn });
    await expect(connector.deliver(hubEvent(), ctx())).rejects.toThrow(/crm\.example\.test/);
  });
});
