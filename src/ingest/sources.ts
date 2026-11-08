import { createHash } from "node:crypto";
import { verifyGenericSignature, verifyStripeSignature, type VerifyResult } from "./signature.js";

/** What an inbound source must provide: how to trust a request and how to name the event. */
export interface Source {
  name: string;
  verify(rawBody: string, headers: Headers, now?: number): VerifyResult;
  /** Pull the provider's event id (the idempotency key) and type out of the body. */
  extract(body: unknown, headers: Headers, rawBody: string): { externalId: string; type: string };
}

export class BadPayloadError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stripeSource(secret: string, toleranceSeconds: number): Source {
  return {
    name: "stripe",
    verify: (rawBody, headers, now) =>
      verifyStripeSignature(rawBody, headers.get("stripe-signature") ?? undefined, secret, { toleranceSeconds, now }),
    extract: (body) => {
      if (!isRecord(body) || typeof body.id !== "string" || typeof body.type !== "string") {
        throw new BadPayloadError("Stripe event must have string `id` and `type`");
      }
      return { externalId: body.id, type: body.type };
    },
  };
}

export function genericSource(secret: string, toleranceSeconds: number): Source {
  return {
    name: "generic",
    verify: (rawBody, headers, now) =>
      verifyGenericSignature(
        rawBody,
        headers.get("x-signature") ?? undefined,
        headers.get("x-timestamp") ?? undefined,
        secret,
        { toleranceSeconds, now },
      ),
    extract: (body, headers, rawBody) => {
      if (!isRecord(body)) throw new BadPayloadError("Body must be a JSON object");
      // Prefer an explicit key, then the payload's own id, then a hash of the body
      // so that a byte-identical retry is still deduplicated.
      const externalId =
        headers.get("idempotency-key") ??
        (typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : null) ??
        `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
      const type = typeof body.type === "string" ? body.type : "generic.event";
      return { externalId, type };
    },
  };
}
