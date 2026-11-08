import { PermanentError, RetryableError } from "../queue/errors.js";

export type FetchFn = typeof fetch;

/** Parses Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Maps an HTTP response to the retry policy shared by all HTTP connectors:
 * 2xx ok; 408, 425, 429 and 5xx retry; other 4xx are permanent.
 */
export async function assertOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.text().catch(() => "")).slice(0, 500);
  const message = `${what} responded ${res.status}${body ? `: ${body}` : ""}`;
  if (res.status === 429 || res.status === 408 || res.status === 425 || res.status >= 500) {
    throw new RetryableError(message, parseRetryAfter(res.headers.get("retry-after")));
  }
  throw new PermanentError(message);
}

/** fetch with a timeout; network errors and timeouts are retryable. */
export async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(parent ? [parent] : [])];
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (err) {
    throw new RetryableError(`request to ${new URL(url).host} failed: ${(err as Error).message}`);
  }
}
