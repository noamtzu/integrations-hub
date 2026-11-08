import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { createPool, type Pool } from "../../src/db/pool.js";

/** One pool per test file, migrated once, with every table emptied before each test. */
export function useTestDatabase(): { pool: () => Pool } {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(inject("databaseUrl"), 20);
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE delivery_attempts, deliveries, events RESTART IDENTITY CASCADE");
  });
  afterAll(async () => {
    await pool.end();
  });
  return { pool: () => pool };
}

/** Moves a delivery's run_at into the past so the next claim picks it up (instead of sleeping). */
export async function makeRunnable(pool: Pool, deliveryId?: number): Promise<void> {
  await pool.query(
    "UPDATE deliveries SET run_at = now() - interval '1 second' WHERE status = 'pending' AND ($1::bigint IS NULL OR id = $1)",
    [deliveryId ?? null],
  );
}
