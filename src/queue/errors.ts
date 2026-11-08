/** The destination may accept this later (timeout, 5xx, 429). The job is retried with backoff. */
export class RetryableError extends Error {
  constructor(
    message: string,
    /** A destination-provided wait (e.g. Retry-After); used when longer than the backoff. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

/** Retrying cannot help (bad request, auth rejected, payload invalid). Goes straight to dead-letter. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
