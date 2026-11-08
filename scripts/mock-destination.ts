/**
 * A local stand-in for a CRM/webhook destination that fails on purpose, so the
 * retry, backoff and dead-letter paths can be watched in the dashboard.
 *
 *   FAIL_RATE=0.5 npm run mock:destination
 *
 * Point OUTBOUND_WEBHOOK_URL at http://localhost:4000/hook.
 * Payloads with an email ending in "@invalid.test" get a 422 (permanent failure).
 */
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 4000);
const failRate = Number(process.env.FAIL_RATE ?? 0.3);
const seen = new Set<string>();

createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    const key = String(req.headers["idempotency-key"] ?? "");
    const attempt = String(req.headers["x-hub-attempt"] ?? "?");
    if (body.includes("@invalid.test")) {
      res.writeHead(422).end(JSON.stringify({ message: "Property values were not valid" }));
      console.log(`422 attempt=${attempt} key=${key.slice(0, 12)}`);
      return;
    }
    if (Math.random() < failRate) {
      const status = Math.random() < 0.5 ? 503 : 429;
      res.writeHead(status, status === 429 ? { "retry-after": "2" } : {}).end("try later");
      console.log(`${status} attempt=${attempt} key=${key.slice(0, 12)}`);
      return;
    }
    const replay = seen.has(key);
    seen.add(key);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, replay }));
    console.log(`200 attempt=${attempt} key=${key.slice(0, 12)}${replay ? " (idempotent replay)" : ""}`);
  });
}).listen(port, () => console.log(`mock destination on :${port}, fail rate ${failRate}`));
