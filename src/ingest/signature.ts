import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Current time in seconds; injectable for tests. */
  now?: number;
}

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  // Buffer.from(…, "hex") drops invalid characters, so check lengths against the input too.
  if (bufA.length !== bufB.length || bufA.length * 2 !== a.length || bufB.length * 2 !== b.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function checkTimestamp(timestamp: number, opts: VerifyOptions): VerifyResult {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "timestamp outside tolerance" };
  return { ok: true };
}

/**
 * Verifies a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=<hex>…]`).
 * The signed payload is `${t}.${rawBody}`. Several v1 entries can appear while
 * a secret is being rolled; any match is accepted.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (key === "t" && value) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) {
    return { ok: false, reason: "malformed Stripe-Signature header" };
  }

  const ts = checkTimestamp(timestamp, opts);
  if (!ts.ok) return ts;

  const expected = hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((sig) => safeEqualHex(sig, expected))
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/**
 * Verifies the generic scheme used by many providers:
 *   X-Timestamp: <unix seconds>
 *   X-Signature: sha256=<hex of HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 * Binding the timestamp into the signature is what stops replay of old requests.
 */
export function verifyGenericSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing X-Signature header" };
  if (!timestampHeader) return { ok: false, reason: "missing X-Timestamp header" };
  const match = /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim());
  if (!match?.[1]) return { ok: false, reason: "malformed X-Signature header" };

  const timestamp = Number(timestampHeader);
  const ts = checkTimestamp(timestamp, opts);
  if (!ts.ok) return ts;

  const expected = hmacSha256Hex(secret, `${timestampHeader}.${rawBody}`);
  return safeEqualHex(match[1].toLowerCase(), expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}
