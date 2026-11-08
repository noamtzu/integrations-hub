import pino from "pino";
import { hmacSha256Hex } from "../../src/ingest/signature.js";
import type { DeliveryContext, HubEvent } from "../../src/connectors/types.js";

export const silentLog = pino({ level: "silent" });

export const STRIPE_SECRET = "whsec_test_secret";
export const GENERIC_SECRET = "generic_test_secret";

export function stripeEvent(id = "evt_1", type = "checkout.session.completed") {
  return {
    id,
    object: "event",
    type,
    data: {
      object: {
        id: "cs_test_1",
        amount_total: 4900,
        currency: "usd",
        customer_details: { email: "jane.doe@example.com", name: "Jane Q Doe" },
      },
    },
  };
}

export function signStripe(body: string, secret = STRIPE_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}`;
}

export function signGeneric(body: string, secret = GENERIC_SECRET, t = Math.floor(Date.now() / 1000)) {
  return { "x-timestamp": String(t), "x-signature": `sha256=${hmacSha256Hex(secret, `${t}.${body}`)}` };
}

export function hubEvent(overrides: Partial<HubEvent> = {}): HubEvent {
  return {
    id: 42,
    source: "stripe",
    externalId: "evt_1",
    type: "checkout.session.completed",
    payload: stripeEvent(),
    receivedAt: new Date("2026-01-15T10:00:00Z"),
    ...overrides,
  };
}

export function ctx(overrides: Partial<DeliveryContext> = {}): DeliveryContext {
  return {
    idempotencyKey: "idem-123",
    attempt: 1,
    log: silentLog,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A fetch stub that records calls and answers from a queue of responses. */
export function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
    const next = responses.shift();
    if (!next) throw new Error("fakeFetch: no response queued");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
