import { describe, expect, it } from "vitest";
import {
  hmacSha256Hex,
  safeEqualHex,
  verifyGenericSignature,
  verifyStripeSignature,
} from "../../src/ingest/signature.js";

const secret = "whsec_test";
const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
const now = 1_760_000_000;
const sign = (t: number, s = secret, b = body) => hmacSha256Hex(s, `${t}.${b}`);

describe("verifyStripeSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifyStripeSignature(body, `t=${now},v1=${sign(now)}`, secret, { now })).toEqual({ ok: true });
  });

  it("accepts when any of several v1 signatures matches (secret rotation)", () => {
    const header = `t=${now},v1=${sign(now, "old_secret")},v1=${sign(now)}`;
    expect(verifyStripeSignature(body, header, secret, { now }).ok).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const r = verifyStripeSignature(body, `t=${now},v1=${sign(now, "wrong")}`, secret, { now });
    expect(r).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a tampered body", () => {
    const tampered = body.replace("invoice.paid", "invoice.voided");
    expect(verifyStripeSignature(tampered, `t=${now},v1=${sign(now)}`, secret, { now }).ok).toBe(false);
  });

  it("rejects a timestamp outside the tolerance (replay protection)", () => {
    const old = now - 301;
    const r = verifyStripeSignature(body, `t=${old},v1=${sign(old)}`, secret, { now, toleranceSeconds: 300 });
    expect(r).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });

  it("rejects missing and malformed headers", () => {
    expect(verifyStripeSignature(body, undefined, secret, { now }).ok).toBe(false);
    expect(verifyStripeSignature(body, "garbage", secret, { now })).toEqual({
      ok: false,
      reason: "malformed Stripe-Signature header",
    });
    expect(verifyStripeSignature(body, `t=${now}`, secret, { now }).ok).toBe(false);
  });

  it("ignores unknown schemes such as v0", () => {
    expect(verifyStripeSignature(body, `t=${now},v0=${sign(now)}`, secret, { now }).ok).toBe(false);
  });
});

describe("verifyGenericSignature", () => {
  const sig = (t: number, s = secret) => `sha256=${sign(t, s)}`;

  it("accepts a valid signature", () => {
    expect(verifyGenericSignature(body, sig(now), String(now), secret, { now })).toEqual({ ok: true });
  });

  it("accepts an upper-case hex digest", () => {
    expect(verifyGenericSignature(body, `sha256=${sign(now).toUpperCase()}`, String(now), secret, { now }).ok).toBe(true);
  });

  it("rejects a wrong secret, a stale timestamp and a timestamp that differs from the signed one", () => {
    expect(verifyGenericSignature(body, sig(now, "nope"), String(now), secret, { now }).ok).toBe(false);
    expect(verifyGenericSignature(body, sig(now - 600), String(now - 600), secret, { now }).ok).toBe(false);
    expect(verifyGenericSignature(body, sig(now - 10), String(now), secret, { now }).ok).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    expect(verifyGenericSignature(body, undefined, String(now), secret, { now }).ok).toBe(false);
    expect(verifyGenericSignature(body, sig(now), undefined, secret, { now }).ok).toBe(false);
    expect(verifyGenericSignature(body, "md5=abc", String(now), secret, { now }).ok).toBe(false);
    expect(verifyGenericSignature(body, sig(now), "not-a-number", secret, { now }).ok).toBe(false);
  });
});

describe("safeEqualHex", () => {
  it("compares equal and unequal digests", () => {
    expect(safeEqualHex("abcd", "abcd")).toBe(true);
    expect(safeEqualHex("abcd", "abce")).toBe(false);
  });
  it("returns false for different lengths or non-hex input instead of throwing", () => {
    expect(safeEqualHex("abcd", "abcdef")).toBe(false);
    expect(safeEqualHex("zzzz", "zzzz")).toBe(false);
  });
});
