import { createHash } from "node:crypto";
import { withTransaction, type Pool } from "../db/pool.js";

export interface IncomingEvent {
  source: string;
  externalId: string;
  type: string;
  payload: unknown;
}

export interface IngestResult {
  eventId: number;
  duplicate: boolean;
  deliveries: number;
}

/** Stable per (connector, event) key, sent to destinations that support idempotency. */
export function deliveryIdempotencyKey(connector: string, source: string, externalId: string): string {
  return createHash("sha256").update(`${connector}\u0000${source}\u0000${externalId}`).digest("hex");
}

/**
 * Stores the event and its delivery jobs in one transaction (a transactional outbox).
 * The HTTP handler answers 2xx only after this commits, so an accepted webhook is
 * never lost, and a provider retry of the same event changes nothing.
 */
export async function ingestEvent(
  pool: Pool,
  event: IncomingEvent,
  connectors: string[],
  maxAttempts: number,
): Promise<IngestResult> {
  return withTransaction(pool, async (tx) => {
    const inserted = await tx.query<{ id: number }>(
      `INSERT INTO events (source, external_id, type, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT events_source_external_id_key DO NOTHING
       RETURNING id`,
      [event.source, event.externalId, event.type, JSON.stringify(event.payload)],
    );

    if (inserted.rows.length === 0) {
      const existing = await tx.query<{ id: number }>(
        "SELECT id FROM events WHERE source = $1 AND external_id = $2",
        [event.source, event.externalId],
      );
      return { eventId: existing.rows[0]!.id, duplicate: true, deliveries: 0 };
    }

    const eventId = inserted.rows[0]!.id;
    for (const connector of connectors) {
      await tx.query(
        `INSERT INTO deliveries (event_id, connector, max_attempts, idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [eventId, connector, maxAttempts, deliveryIdempotencyKey(connector, event.source, event.externalId)],
      );
    }
    return { eventId, duplicate: false, deliveries: connectors.length };
  });
}
