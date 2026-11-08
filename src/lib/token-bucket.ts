/**
 * Token bucket rate limiter: `ratePerSecond` tokens refill continuously up to
 * `burst`. One delivery costs one token. The clock is injectable for tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = Math.max(1, Math.ceil(ratePerSecond)),
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.last = t;
  }

  /** Whole tokens available right now. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Takes up to `n` tokens and returns how many were taken. */
  take(n = 1): number {
    this.refill();
    const granted = Math.min(n, Math.floor(this.tokens));
    this.tokens -= granted;
    return granted;
  }

  /** Milliseconds until one more token is available. */
  msUntilNext(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }
}
