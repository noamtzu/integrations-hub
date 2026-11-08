import type { TestProject } from "vitest/node";

/**
 * Integration tests need a real Postgres.
 *  - If TEST_DATABASE_URL is set (CI service container, docker compose), use it.
 *  - Otherwise start a throwaway container with Testcontainers (needs Docker).
 */
export default async function setup(project: TestProject) {
  const fromEnv = process.env.TEST_DATABASE_URL;
  if (fromEnv) {
    project.provide("databaseUrl", fromEnv);
    return;
  }
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  project.provide("databaseUrl", container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
