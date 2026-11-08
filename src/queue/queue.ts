import type { Pool } from "../db/pool.js";

export type DeliveryStatus = "pending" | "running" | "succeeded" | "dead";

export interface ClaimedDelivery {
  id: number;
  eventId: number;
  connector: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  event: {
    id: number;
    source: string;
    externalId: string;
    type: string;
    payload: unknown;
    receivedAt: Date;
  };
}

interface ClaimRow {
  id: number;
  event_id: number;
  connector: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  source: string;
  external_id: string;
  type: string;
  payload: unknown;
  received_at: Date;
}

export type FailOutcome = { outcome: "retry"; runAt: Date } | { outcome: "dead" };

/**
 * Postgres-backed job queue. Every method is one statement, so the queue is
 * correct with any number of worker processes.
 */
export class DeliveryQueue {
  constructor(
    private readonly pool: Pool,
    private readonly leaseSeconds: number,
  ) {}

  /**
   * Claims up to `limit` runnable jobs for one connector.
   *
   * FOR UPDATE SKIP LOCKED lets concurrent workers each take different rows
   * without blocking. A `running` row whose lease expired belongs to a worker
   * that crashed; it is claimed again, which is why delivery is at-least-once.
   */
  async claim(connector: string, limit: number, workerId: string): Promise<ClaimedDelivery[]> {
    if (limit <= 0) return [];
    const { rows } = await this.pool.query<ClaimRow>(
      `WITH next AS (
         SELECT id FROM deliveries
         WHERE connector = $1
           AND ((status = 'pending' AND run_at <= now())
             OR (status = 'running' AND locked_at < now() - make_interval(secs => $3)))
         ORDER BY run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE deliveries d
          SET status = 'running', locked_at = now(), locked_by = $4,
              attempts = d.attempts + 1, updated_at = now()
         FROM next, events e
        WHERE d.id = next.id AND e.id = d.event_id
       RETURNING d.id, d.event_id, d.connector, d.attempts, d.max_attempts, d.idempotency_key,
                 e.source, e.external_id, e.type, e.payload, e.received_at`,
      [connector, limit, this.leaseSeconds, workerId],
    );
    return rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      connector: r.connector,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      idempotencyKey: r.idempotency_key,
      event: {
        id: r.event_id,
        source: r.source,
        externalId: r.external_id,
        type: r.type,
        payload: r.payload,
        receivedAt: r.received_at,
      },
    }));
  }

  /**
   * Marks a job done. The `locked_by` check is a fence: if our lease expired and
   * another worker re-claimed the row, we must not overwrite its state.
   */
  async complete(job: ClaimedDelivery, workerId: string, durationMs: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `WITH done AS (
         UPDATE deliveries
            SET status = 'succeeded', completed_at = now(), updated_at = now(),
                locked_at = NULL, locked_by = NULL, last_error = NULL
          WHERE id = $1 AND status = 'running' AND locked_by = $2 AND attempts = $3
         RETURNING id
       )
       INSERT INTO delivery_attempts (delivery_id, attempt, outcome, duration_ms)
       SELECT id, $3, 'succeeded', $4 FROM done`,
      [job.id, workerId, job.attempts, durationMs],
    );
    return rowCount === 1;
  }

  /**
   * Records a failure. Retries at `retryAt` unless the error is permanent or the
   * attempts are used up, in which case the job moves to the dead-letter list.
   */
  async fail(
    job: ClaimedDelivery,
    workerId: string,
    error: string,
    opts: { permanent: boolean; retryInMs: number; durationMs: number },
  ): Promise<FailOutcome | null> {
    const dead = opts.permanent || job.attempts >= job.maxAttempts;
    const { rows } = await this.pool.query<{ run_at: Date }>(
      `WITH failed AS (
         UPDATE deliveries
            SET status = $4, last_error = $5, updated_at = now(),
                run_at = CASE WHEN $4 = 'pending' THEN now() + make_interval(secs => $6) ELSE run_at END,
                locked_at = NULL, locked_by = NULL
          WHERE id = $1 AND status = 'running' AND locked_by = $2 AND attempts = $3
         RETURNING id, run_at
       ), audit AS (
         INSERT INTO delivery_attempts (delivery_id, attempt, outcome, error, duration_ms)
         SELECT id, $3, $7, $5, $8 FROM failed
       )
       SELECT run_at FROM failed`,
      [
        job.id,
        workerId,
        job.attempts,
        dead ? "dead" : "pending",
        error.slice(0, 2000),
        opts.retryInMs / 1000,
        dead ? "dead" : "retry",
        opts.durationMs,
      ],
    );
    const row = rows[0];
    if (!row) return null; // lost the lease; someone else owns the job now
    return dead ? { outcome: "dead" } : { outcome: "retry", runAt: row.run_at };
  }

  /**
   * Puts a dead job back in the queue with a fresh attempt budget. Only dead jobs
   * can be replayed, so a double click cannot run a live job twice.
   */
  async replay(deliveryId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE deliveries
          SET status = 'pending', attempts = 0, run_at = now(), last_error = NULL,
              completed_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'dead'`,
      [deliveryId],
    );
    return rowCount === 1;
  }

  /** Replays every dead job, optionally for one connector. Returns how many were requeued. */
  async replayAllDead(connector?: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE deliveries
          SET status = 'pending', attempts = 0, run_at = now(), last_error = NULL,
              completed_at = NULL, updated_at = now()
        WHERE status = 'dead' AND ($1::text IS NULL OR connector = $1)`,
      [connector ?? null],
    );
    return rowCount ?? 0;
  }

  async countsByStatus(): Promise<Array<{ connector: string; status: DeliveryStatus; count: number }>> {
    const { rows } = await this.pool.query<{ connector: string; status: DeliveryStatus; count: number }>(
      "SELECT connector, status, count(*)::int AS count FROM deliveries GROUP BY connector, status ORDER BY connector, status",
    );
    return rows;
  }
}
