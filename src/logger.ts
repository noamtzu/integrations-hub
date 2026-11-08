import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: { service: "integrations-hub" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        'req.headers["stripe-signature"]',
        'req.headers["x-signature"]',
        "*.privateKey",
        "*.secret",
      ],
      censor: "[redacted]",
    },
  });
}
