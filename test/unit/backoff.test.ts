import { describe, expect, it } from "vitest";
import { backoffDelay } from "../../src/queue/backoff.js";

const opts = { baseMs: 1000, maxMs: 60_000 };

describe("backoffDelay", () => {
  it("doubles the window on every attempt", () => {
    const max = (a: number) => backoffDelay(a, { ...opts, random: () => 0.999999 });
    expect([1, 2, 3, 4].map(max)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("never goes below half the window, so delays always grow", () => {
    const min = (a: number) => backoffDelay(a, { ...opts, random: () => 0 });
    expect([1, 2, 3, 4].map(min)).toEqual([500, 1000, 2000, 4000]);
  });

  it("caps at maxMs", () => {
    expect(backoffDelay(30, { ...opts, random: () => 0.999999 })).toBe(60_000);
    expect(backoffDelay(30, { ...opts, random: () => 0 })).toBe(30_000);
  });

  it("spreads retries across the jitter range", () => {
    const samples = Array.from({ length: 500 }, () => backoffDelay(5, opts));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(8000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(16_000);
    expect(new Set(samples).size).toBeGreaterThan(100);
  });
});
