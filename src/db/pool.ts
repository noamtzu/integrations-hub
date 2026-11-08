import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, "query">;

// Return BIGINT/BIGSERIAL as JS numbers. Ids here stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({ connectionString, max, application_name: "integrations-hub" });
}

/** Runs `fn` inside a transaction and rolls back on any error. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
