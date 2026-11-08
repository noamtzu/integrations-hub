import { hmacSha256Hex } from "../ingest/signature.js";
import { assertOk, fetchWithTimeout, type FetchFn } from "./http.js";
import type { Connector, DeliveryContext, HubEvent } from "./types.js";

export interface WebhookConnectorOptions {
  name?: string;
  url: string;
  /** When set, requests carry X-Hub-Signature: sha256=HMAC(secret, `${timestamp}.${body}`). */
  secret?: string;
  ratePerSecond?: number;
  timeoutMs?: number;
  fetch?: FetchFn;
  accepts?: Connector["accepts"];
  /** Builds the outbound body. Defaults to a HubSpot-style contact upsert. */
  transform?: (event: HubEvent) => unknown;
}

function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Example mapping into the shape HubSpot's CRM API uses for a contact upsert
 * (`{ idProperty, id, properties }`). Works for Stripe customer and checkout
 * events and for generic payloads carrying `email`/`name`.
 */
export function toHubSpotContact(event: HubEvent): unknown {
  const obj = get(event.payload, "data", "object") ?? event.payload;
  const email =
    str(get(obj, "email")) ?? str(get(obj, "customer_details", "email")) ?? str(get(obj, "customer_email"));
  const name = str(get(obj, "name")) ?? str(get(obj, "customer_details", "name"));
  const [firstname, ...rest] = (name ?? "").split(" ");
  const amount = get(obj, "amount_total") ?? get(obj, "amount_paid");

  return {
    idProperty: "email",
    id: email ?? null,
    properties: {
      email: email ?? null,
      firstname: firstname || null,
      lastname: rest.join(" ") || null,
      last_event_type: event.type,
      last_event_source: event.source,
      last_payment_amount: typeof amount === "number" ? (amount / 100).toFixed(2) : null,
      last_payment_currency: str(get(obj, "currency"))?.toUpperCase() ?? null,
    },
    context: { hubEventId: event.id, sourceEventId: event.externalId, occurredAt: event.receivedAt.toISOString() },
  };
}

/** Generic outbound webhook: POSTs JSON, signs it, and sends an Idempotency-Key. */
export function webhookConnector(opts: WebhookConnectorOptions): Connector {
  const fetchFn = opts.fetch ?? fetch;
  const transform = opts.transform ?? toHubSpotContact;
  return {
    name: opts.name ?? "webhook",
    ratePerSecond: opts.ratePerSecond ?? 5,
    accepts: opts.accepts ?? (() => true),
    async deliver(event: HubEvent, ctx: DeliveryContext): Promise<void> {
      const body = JSON.stringify(transform(event));
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "integrations-hub/1.0",
        "idempotency-key": ctx.idempotencyKey,
        "x-hub-event-type": event.type,
        "x-hub-attempt": String(ctx.attempt),
        "x-hub-timestamp": timestamp,
      };
      if (opts.secret) headers["x-hub-signature"] = `sha256=${hmacSha256Hex(opts.secret, `${timestamp}.${body}`)}`;

      const res = await fetchWithTimeout(
        fetchFn,
        opts.url,
        { method: "POST", headers, body },
        opts.timeoutMs ?? 10_000,
        ctx.signal,
      );
      await assertOk(res, "webhook destination");
    },
  };
}
