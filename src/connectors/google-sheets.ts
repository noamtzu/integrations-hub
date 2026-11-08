import { createSign } from "node:crypto";
import { PermanentError } from "../queue/errors.js";
import { assertOk, fetchWithTimeout, type FetchFn } from "./http.js";
import type { Connector, DeliveryContext, HubEvent } from "./types.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
}

/**
 * OAuth2 access tokens for a Google service account (JWT bearer grant), cached
 * until shortly before they expire. Uses node:crypto only, no Google SDK.
 */
export function serviceAccountTokenProvider(
  clientEmail: string,
  privateKey: string,
  fetchFn: FetchFn = fetch,
): TokenProvider {
  let cached: { token: string; expiresAt: number } | undefined;
  const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

  return {
    async getToken(signal) {
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claims = b64url(
        JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
      );
      const signature = createSign("RSA-SHA256")
        .update(`${header}.${claims}`)
        .sign(privateKey.replace(/\\n/g, "\n"));
      const assertion = `${header}.${claims}.${b64url(signature)}`;

      const res = await fetchWithTimeout(
        fetchFn,
        TOKEN_URL,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        },
        10_000,
        signal,
      );
      await assertOk(res, "Google OAuth");
      const json = (await res.json()) as { access_token: string; expires_in: number };
      cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
      return json.access_token;
    },
  };
}

export interface GoogleSheetsOptions {
  spreadsheetId: string;
  /** A1 range to append into, e.g. "Events!A:F". Column A holds the event key. */
  range: string;
  tokens: TokenProvider;
  ratePerSecond?: number;
  fetch?: FetchFn;
  accepts?: Connector["accepts"];
  toRow?: (event: HubEvent) => Array<string | number | null>;
}

function field(payload: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (cur, k) => (typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[k] : undefined),
    payload,
  );
}

/** Default row: key, received at, source, type, customer email, amount. */
export function defaultRow(event: HubEvent): Array<string | number | null> {
  const obj = field(event.payload, "data", "object") ?? event.payload;
  const email = field(obj, "customer_details", "email") ?? field(obj, "customer_email") ?? field(obj, "email");
  const amount = field(obj, "amount_total") ?? field(obj, "amount_paid") ?? field(obj, "amount");
  return [
    eventKey(event),
    event.receivedAt.toISOString(),
    event.source,
    event.type,
    typeof email === "string" ? email : null,
    typeof amount === "number" ? amount / 100 : null,
  ];
}

export const eventKey = (event: Pick<HubEvent, "source" | "externalId">) => `${event.source}:${event.externalId}`;

/**
 * Appends one row per event to a Google Sheet.
 *
 * Sheets "append" is not idempotent: if a request times out after Google wrote
 * the row, a blind retry would write it twice. So on a retry (attempt > 1) the
 * connector first reads column A and skips the append when the key is already
 * there. First attempts pay no extra read.
 */
export function googleSheetsConnector(opts: GoogleSheetsOptions): Connector {
  const fetchFn = opts.fetch ?? fetch;
  const toRow = opts.toRow ?? defaultRow;
  const sheet = opts.range.includes("!") ? opts.range.split("!")[0] : undefined;
  if (!sheet) throw new PermanentError(`GOOGLE_SHEETS_RANGE must include a sheet name, got "${opts.range}"`);
  const base = `${SHEETS_API}/${encodeURIComponent(opts.spreadsheetId)}/values`;

  async function alreadyWritten(key: string, token: string, signal: AbortSignal): Promise<boolean> {
    const res = await fetchWithTimeout(
      fetchFn,
      `${base}/${encodeURIComponent(`${sheet}!A:A`)}?majorDimension=COLUMNS`,
      { headers: { authorization: `Bearer ${token}` } },
      10_000,
      signal,
    );
    await assertOk(res, "Google Sheets read");
    const json = (await res.json()) as { values?: string[][] };
    return (json.values?.[0] ?? []).includes(key);
  }

  return {
    name: "google-sheets",
    ratePerSecond: opts.ratePerSecond ?? 1,
    accepts: opts.accepts ?? (() => true),
    async deliver(event: HubEvent, ctx: DeliveryContext): Promise<void> {
      const token = await opts.tokens.getToken(ctx.signal);
      const key = eventKey(event);

      if (ctx.attempt > 1 && (await alreadyWritten(key, token, ctx.signal))) {
        ctx.log.info({ key }, "row already present, skipping append");
        return;
      }

      const res = await fetchWithTimeout(
        fetchFn,
        `${base}/${encodeURIComponent(opts.range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ values: [toRow(event)] }),
        },
        10_000,
        ctx.signal,
      );
      await assertOk(res, "Google Sheets append");
    },
  };
}
