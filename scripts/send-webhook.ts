/**
 * Sends a correctly signed sample webhook to a running hub.
 *
 *   npm run send:stripe            # checkout.session.completed
 *   npm run send:stripe -- --dup   # send the same event twice (shows dedupe)
 *   npm run send:generic
 */
import { randomBytes } from "node:crypto";
import { hmacSha256Hex } from "../src/ingest/signature.js";

const kind = process.argv[2] ?? "stripe";
const dup = process.argv.includes("--dup");
const base = process.env.HUB_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const ts = Math.floor(Date.now() / 1000).toString();

let body: string;
let headers: Record<string, string>;

if (kind === "stripe") {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_local_dev_only";
  body = JSON.stringify({
    id: `evt_${randomBytes(12).toString("hex")}`,
    object: "event",
    type: "checkout.session.completed",
    created: Number(ts),
    data: {
      object: {
        id: `cs_test_${randomBytes(8).toString("hex")}`,
        object: "checkout.session",
        amount_total: 4900,
        currency: "usd",
        customer_details: { email: "jane.doe@example.com", name: "Jane Doe" },
      },
    },
  });
  headers = { "stripe-signature": `t=${ts},v1=${hmacSha256Hex(secret, `${ts}.${body}`)}` };
} else {
  const secret = process.env.GENERIC_WEBHOOK_SECRET ?? "generic_local_dev_only";
  body = JSON.stringify({
    id: `ord_${randomBytes(6).toString("hex")}`,
    type: "order.created",
    email: "sam.lee@example.com",
    name: "Sam Lee",
    amount: 12900,
  });
  headers = { "x-timestamp": ts, "x-signature": `sha256=${hmacSha256Hex(secret, `${ts}.${body}`)}` };
}

for (let i = 0; i < (dup ? 2 : 1); i++) {
  const res = await fetch(`${base}/webhooks/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  console.log(res.status, await res.text());
}
