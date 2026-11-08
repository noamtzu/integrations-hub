export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Returns a number in [0, 1). Injectable so tests are deterministic. */
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": half of the window is fixed, half is random.
 *
 *   window = min(maxMs, baseMs * 2^(attempt-1))
 *   delay  = window/2 + random * window/2
 *
 * The fixed half guarantees the delay actually grows; the random half spreads out
 * retries so a destination that recovers is not hit by every failed job at once.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const random = opts.random ?? Math.random;
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt - 1));
  const half = exp / 2;
  return Math.round(half + random() * half);
}
