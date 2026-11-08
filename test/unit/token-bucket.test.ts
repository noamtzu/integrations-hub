import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../src/lib/token-bucket.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TokenBucket", () => {
  it("starts full and grants up to the burst", () => {
    const c = clock();
    const b = new TokenBucket(2, 5, c.now);
    expect(b.take(10)).toBe(5);
    expect(b.available()).toBe(0);
  });

  it("refills at the configured rate", () => {
    const c = clock();
    const b = new TokenBucket(2, 2, c.now);
    b.take(2);
    c.advance(499);
    expect(b.available()).toBe(0);
    c.advance(1);
    expect(b.available()).toBe(1);
    c.advance(10_000);
    expect(b.available()).toBe(2); // never above burst
  });

  it("reports the wait until the next token", () => {
    const c = clock();
    const b = new TokenBucket(4, 1, c.now);
    b.take();
    expect(b.msUntilNext()).toBe(250);
    c.advance(100);
    expect(b.msUntilNext()).toBe(150);
  });

  it("supports fractional rates", () => {
    const c = clock();
    const b = new TokenBucket(0.5, 1, c.now);
    b.take();
    c.advance(1999);
    expect(b.available()).toBe(0);
    c.advance(1);
    expect(b.available()).toBe(1);
  });
});
