import type { Config } from "../config.js";
import { googleSheetsConnector, serviceAccountTokenProvider } from "./google-sheets.js";
import type { Connector } from "./types.js";
import { webhookConnector } from "./webhook.js";

/**
 * Builds the connectors that have configuration. A connector without its
 * settings is simply not registered, so the service runs with any subset.
 * Routing lives here too: each connector says which events it wants.
 */
export function connectorsFromConfig(config: Config): Connector[] {
  const connectors: Connector[] = [];

  if (
    config.GOOGLE_SHEETS_SPREADSHEET_ID &&
    config.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  ) {
    connectors.push(
      googleSheetsConnector({
        spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
        range: config.GOOGLE_SHEETS_RANGE,
        tokens: serviceAccountTokenProvider(
          config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        ),
        ratePerSecond: config.GOOGLE_SHEETS_RATE_PER_SECOND,
        // Payments ledger: only money-moving Stripe events, plus anything generic.
        accepts: (e) =>
          e.source === "generic" ||
          ["checkout.session.completed", "invoice.paid", "charge.refunded"].includes(e.type),
      }),
    );
  }

  if (config.OUTBOUND_WEBHOOK_URL) {
    connectors.push(
      webhookConnector({
        name: "webhook",
        url: config.OUTBOUND_WEBHOOK_URL,
        secret: config.OUTBOUND_WEBHOOK_SECRET,
        ratePerSecond: config.OUTBOUND_WEBHOOK_RATE_PER_SECOND,
        // CRM sync: customer and checkout events.
        accepts: (e) =>
          e.source === "generic" || e.type.startsWith("customer.") || e.type === "checkout.session.completed",
      }),
    );
  }

  return connectors;
}
