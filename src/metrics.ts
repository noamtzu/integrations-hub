import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { DeliveryQueue } from "./queue/queue.js";

export type Metrics = ReturnType<typeof createMetrics>;

/** Prometheus metrics. One registry per app instance keeps tests isolated. */
export function createMetrics(queue?: DeliveryQueue, opts: { defaultMetrics?: boolean } = {}) {
  const registry = new Registry();
  if (opts.defaultMetrics) collectDefaultMetrics({ register: registry });

  const webhooksReceived = new Counter({
    name: "hub_webhooks_received_total",
    help: "Inbound webhooks by source and result (accepted, duplicate, rejected).",
    labelNames: ["source", "result"] as const,
    registers: [registry],
  });
  const deliveryAttempts = new Counter({
    name: "hub_delivery_attempts_total",
    help: "Delivery attempts by connector and outcome (succeeded, retry, dead).",
    labelNames: ["connector", "outcome"] as const,
    registers: [registry],
  });
  const deliveryDuration = new Histogram({
    name: "hub_delivery_duration_seconds",
    help: "Time spent in connector.deliver().",
    labelNames: ["connector"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  new Gauge({
    name: "hub_deliveries",
    help: "Deliveries currently in each status, read from Postgres at scrape time.",
    labelNames: ["connector", "status"] as const,
    registers: [registry],
    async collect() {
      if (!queue) return;
      this.reset();
      for (const row of await queue.countsByStatus()) {
        this.set({ connector: row.connector, status: row.status }, row.count);
      }
    },
  });

  return { registry, webhooksReceived, deliveryAttempts, deliveryDuration };
}
