// The "add a connector in 30 lines" example from the README. It is typechecked
// in CI so the README cannot drift from the real interface.
import { assertOk, fetchWithTimeout } from "../src/connectors/http.js";
import type { Connector } from "../src/connectors/types.js";

export function slackConnector(webhookUrl: string): Connector {
  return {
    name: "slack",
    ratePerSecond: 1, // Slack incoming webhooks: about 1 message per second
    accepts: (e) => e.source === "stripe" && e.type === "charge.refunded",

    async deliver(event, ctx) {
      const charge = (event.payload as { data: { object: { amount_refunded: number; currency: string } } })
        .data.object;
      const text = `Refund: ${(charge.amount_refunded / 100).toFixed(2)} ${charge.currency.toUpperCase()} (${event.externalId})`;

      const res = await fetchWithTimeout(
        fetch,
        webhookUrl,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) },
        5_000,
        ctx.signal, // aborted on shutdown timeout
      );
      await assertOk(res, "Slack"); // 429/5xx -> retry with backoff, other 4xx -> dead-letter
    },
  };
}
