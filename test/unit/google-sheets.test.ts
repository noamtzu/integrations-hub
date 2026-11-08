import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defaultRow,
  googleSheetsConnector,
  serviceAccountTokenProvider,
  type TokenProvider,
} from "../../src/connectors/google-sheets.js";
import { PermanentError, RetryableError } from "../../src/queue/errors.js";
import { ctx, fakeFetch, hubEvent, json } from "../helpers/fixtures.js";

const tokens: TokenProvider = { getToken: async () => "test-token" };
const opts = { spreadsheetId: "sheet123", range: "Events!A:F", tokens };

describe("googleSheetsConnector", () => {
  it("appends one row with the event key in column A", async () => {
    const f = fakeFetch(json(200, { updates: { updatedRows: 1 } }));
    await googleSheetsConnector({ ...opts, fetch: f.fn }).deliver(hubEvent(), ctx());

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet123/values/Events!A%3AF:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body as string)).toEqual({
      values: [["stripe:evt_1", "2026-01-15T10:00:00.000Z", "stripe", "checkout.session.completed", "jane.doe@example.com", 49]],
    });
  });

  it("on a retry, skips the append when the row is already in the sheet", async () => {
    const f = fakeFetch(json(200, { values: [["key", "stripe:evt_0", "stripe:evt_1"]] }));
    await googleSheetsConnector({ ...opts, fetch: f.fn }).deliver(hubEvent(), ctx({ attempt: 2 }));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toContain("/values/Events!A%3AA?majorDimension=COLUMNS");
  });

  it("on a retry, appends when the row is not there yet", async () => {
    const f = fakeFetch(json(200, { values: [["key"]] }), json(200, {}));
    await googleSheetsConnector({ ...opts, fetch: f.fn }).deliver(hubEvent(), ctx({ attempt: 2 }));
    expect(f.calls.map((c) => c.init.method ?? "GET")).toEqual(["GET", "POST"]);
  });

  it("maps Google's error codes to the retry policy", async () => {
    const quota = googleSheetsConnector({ ...opts, fetch: fakeFetch(json(429, { error: "quota" })).fn });
    await expect(quota.deliver(hubEvent(), ctx())).rejects.toBeInstanceOf(RetryableError);
    const forbidden = googleSheetsConnector({ ...opts, fetch: fakeFetch(json(403, { error: "no access" })).fn });
    await expect(forbidden.deliver(hubEvent(), ctx())).rejects.toBeInstanceOf(PermanentError);
  });

  it("requires a sheet name in the range", () => {
    expect(() => googleSheetsConnector({ ...opts, range: "A:F" })).toThrow(PermanentError);
  });

  it("builds a sensible default row for a generic event", () => {
    const row = defaultRow(hubEvent({ source: "generic", externalId: "ord_9", type: "order.created", payload: { email: "a@example.com", amount: 1250 } }));
    expect(row).toEqual(["generic:ord_9", "2026-01-15T10:00:00.000Z", "generic", "order.created", "a@example.com", 12.5]);
  });
});

describe("serviceAccountTokenProvider", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs an RS256 JWT, exchanges it, and caches the token", async () => {
    const f = fakeFetch(json(200, { access_token: "ya29.test", expires_in: 3600 }));
    const provider = serviceAccountTokenProvider("svc@project.iam.gserviceaccount.com", pem, f.fn);

    expect(await provider.getToken()).toBe("ya29.test");
    expect(await provider.getToken()).toBe("ya29.test");
    expect(f.calls).toHaveLength(1);

    const assertion = new URLSearchParams(f.calls[0]!.init.body as URLSearchParams).get("assertion")!;
    const [h, c, s] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: "svc@project.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token" });
    const valid = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"));
    expect(valid).toBe(true);
  });

  it("accepts a key with escaped newlines, as it usually arrives from an env var", async () => {
    const f = fakeFetch(json(200, { access_token: "t", expires_in: 3600 }));
    await expect(serviceAccountTokenProvider("svc@x.test", pem.replace(/\n/g, "\\n"), f.fn).getToken()).resolves.toBe("t");
  });
});
