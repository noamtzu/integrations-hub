import { z } from "zod";

const bool = (fallback: "true" | "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),

  // Inbound sources
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  GENERIC_WEBHOOK_SECRET: z.string().min(1).optional(),
  SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

  // Worker
  WORKER_ENABLED: bool("true"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  BACKOFF_MAX_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),

  // Google Sheets connector (enabled when all three are set)
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().min(1).optional(),
  GOOGLE_SHEETS_RANGE: z.string().default("Events!A:F"),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().min(1).optional(),
  GOOGLE_SHEETS_RATE_PER_SECOND: z.coerce.number().positive().default(1),

  // Outbound webhook connector (enabled when the URL is set)
  OUTBOUND_WEBHOOK_URL: z.string().url().optional(),
  OUTBOUND_WEBHOOK_SECRET: z.string().min(1).optional(),
  OUTBOUND_WEBHOOK_RATE_PER_SECOND: z.coerce.number().positive().default(5),

  // Dashboard basic auth (recommended outside local development)
  DASHBOARD_USER: z.string().min(1).optional(),
  DASHBOARD_PASSWORD: z.string().min(1).optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
