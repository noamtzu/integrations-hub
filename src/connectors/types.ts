import type { Logger } from "../logger.js";

/** The event as a connector sees it. */
export interface HubEvent {
  id: number;
  source: string;
  externalId: string;
  type: string;
  payload: unknown;
  receivedAt: Date;
}

export interface DeliveryContext {
  /** Stable for this (event, connector) pair across every retry. Send it if the destination supports it. */
  idempotencyKey: string;
  /** 1 on the first try. */
  attempt: number;
  log: Logger;
  signal: AbortSignal;
}

/**
 * A destination. Return normally on success. Throw `RetryableError` for failures
 * that may pass later and `PermanentError` for ones that will not. Anything else
 * thrown is treated as retryable.
 */
export interface Connector {
  readonly name: string;
  /** Sustained deliveries per second this destination allows. */
  readonly ratePerSecond: number;
  /** Which events this connector wants. Checked at ingest time. */
  accepts(event: Pick<HubEvent, "source" | "type">): boolean;
  deliver(event: HubEvent, ctx: DeliveryContext): Promise<void>;
}
