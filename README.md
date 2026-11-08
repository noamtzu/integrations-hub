# integrations-hub

[![CI](https://github.com/noamtzu/integrations-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/noamtzu/integrations-hub/actions/workflows/ci.yml)
![Node 22+](https://img.shields.io/badge/node-22%2B-339933)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

A small TypeScript service that receives webhooks (Stripe, plus any HMAC-signed sender), stores them in
Postgres, and delivers them to other systems (Google Sheets, a CRM webhook) without losing or duplicating
anything when those systems are slow, rate limited or down.

It is a reference implementation of the parts that make an integration dependable. The connectors are
deliberately simple; the plumbing around them is the point.

## The problem

"Connect Stripe to our CRM and a spreadsheet" sounds like an afternoon: take the webhook, call two APIs.
That version works in the demo and breaks in production:

- **The destination is down** for ten minutes, and every event in that window is gone.
- **The provider retries** a webhook it thinks failed, and the customer shows up twice in the CRM.
- **The destination rate limits you** (Google Sheets allows about one write per second per user), and a
  burst of sales becomes a burst of 429s.
- **Someone posts a fake webhook** to your public URL, and you happily sync it.
- **Something fails at 3 a.m.** and nobody can tell what was lost, why, or how to resend it.

integrations-hub handles each of these explicitly, and each one has a test.

## Architecture

```mermaid
flowchart LR
    subgraph Sources
        S1[Stripe]
        S2[Any HMAC-signed sender]
    end

    subgraph Hub["integrations-hub (Node + Hono)"]
        V["POST /webhooks/:source<br/>verify signature on raw body"]
        I["ingest: one transaction<br/>events + deliveries"]
        W["worker<br/>claim · deliver · retry"]
        RL["token bucket<br/>per connector"]
        D["dashboard<br/>/health · /metrics"]
    end

    subgraph PG[Postgres]
        E[(events<br/>UNIQUE source+external_id)]
        Q[(deliveries<br/>job queue + dead-letter)]
        A[(delivery_attempts<br/>audit trail)]
    end

    subgraph Destinations
        GS[Google Sheets]
        WH["Webhook / CRM<br/>(HubSpot-shaped)"]
    end

    S1 & S2 -->|HTTPS| V --> I
    I --> E & Q
    W -->|"SELECT … FOR UPDATE SKIP LOCKED"| Q
    W --> RL
    RL --> GS & WH
    W --> A
    D --> Q
```

The request path and the delivery path are separate. The webhook handler only verifies, stores and
answers; it never calls a destination. That keeps response times low (providers time out after a few
seconds) and means a broken destination can never make the hub reject a webhook.

| Piece | File |
|---|---|
| Signature verification (Stripe, generic HMAC) | [`src/ingest/signature.ts`](src/ingest/signature.ts) |
| Ingest transaction (event + jobs) | [`src/ingest/ingest.ts`](src/ingest/ingest.ts) |
| Postgres job queue, retries, dead-letter, replay | [`src/queue/queue.ts`](src/queue/queue.ts) |
| Backoff with jitter | [`src/queue/backoff.ts`](src/queue/backoff.ts) |
| Worker, rate limiting, graceful stop | [`src/queue/worker.ts`](src/queue/worker.ts) |
| Connector interface | [`src/connectors/types.ts`](src/connectors/types.ts) |
| Google Sheets / outbound webhook connectors | [`src/connectors/`](src/connectors) |
| Schema | [`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql) |

## Delivery guarantees

**At-least-once delivery, made safe by idempotency.** Exactly-once delivery over a network is not
available from any system; what you can build is at-least-once delivery where the duplicates do no harm.

1. **An accepted webhook is never lost.** The event row and one delivery job per connector are written in
   a single transaction. The hub answers `200` only after that commit. If the process dies before the
   commit, the provider gets no `200` and sends the webhook again.
2. **A provider retry is a no-op.** `events` has `UNIQUE (source, external_id)` (the Stripe event id, or
   the sender's `Idempotency-Key`). A repeat is answered `200 {"duplicate": true}` so the provider stops,
   and no new jobs are created. Ten concurrent copies of the same event still produce one row (tested).
3. **A job is retried until it succeeds or is dead-lettered.** Failures are classified:
   - *retryable* (timeout, network error, 408, 425, 429, 5xx): retried with exponential backoff and
     jitter, up to `MAX_ATTEMPTS`. A destination's `Retry-After` is honoured when it is longer.
   - *permanent* (other 4xx, invalid payload): moved to the dead-letter list at once. Retrying a `422`
     eight times only delays the alert.
4. **A crashed worker does not strand jobs.** A claimed job holds a lease (`WORKER_LEASE_SECONDS`). If the
   worker dies, the lease expires and another worker claims the job again. A worker that lost its lease
   cannot overwrite the new owner's result: completion checks `locked_by` and the attempt number.
5. **Duplicates are harmless at the destination.** Every job carries a stable `idempotencyKey` (a hash of
   connector, source and event id) that is the same on every retry:
   - the webhook connector sends it as an `Idempotency-Key` header;
   - the Sheets connector writes the event key in column A, and on a retry checks for it before
     appending (Sheets' append API has no idempotency of its own).
6. **Nothing fails silently.** Dead jobs stay in Postgres with their last error and a row per attempt in
   `delivery_attempts`. They show up on the dashboard and in `/metrics`, and can be replayed one by one or
   all at once.

What it does not promise: ordering. Jobs are claimed oldest-first, but a retried job can land after a
newer one. If a destination needs strict per-customer ordering, that is a different design (a partition
key and one in-flight job per key) and I would scope it as such.

## Add a connector in 30 lines

A connector is an object with a name, a rate, a filter and a `deliver` function. Throw `RetryableError` or
`PermanentError` to choose the retry behaviour; the queue does the rest. A Slack notifier for refunds
([`examples/slack-connector.ts`](examples/slack-connector.ts), typechecked in CI):

```ts
// src/connectors/slack.ts
import { assertOk, fetchWithTimeout } from "./http.js";
import type { Connector } from "./types.js";

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
```

Then register it in [`src/connectors/registry.ts`](src/connectors/registry.ts):

```ts
if (config.SLACK_WEBHOOK_URL) connectors.push(slackConnector(config.SLACK_WEBHOOK_URL));
```

Retries, backoff, rate limiting, dead-lettering, replay, metrics and the dashboard all apply to it
without further code. For the test, pass a fake `fetch` the way
[`test/unit/webhook-connector.test.ts`](test/unit/webhook-connector.test.ts) does.

## Running locally

Requirements: Node 22+, and Docker (or any Postgres 14+).

```bash
git clone https://github.com/noamtzu/integrations-hub && cd integrations-hub
npm install
cp .env.example .env
docker compose up -d          # Postgres on localhost:5433
npm run dev                   # migrates, then serves on http://localhost:3000
```

In a second and third terminal:

```bash
FAIL_RATE=0.4 npm run mock:destination   # a CRM stand-in on :4000 that fails 40% of requests
npm run send:stripe                      # a signed checkout.session.completed
npm run send:stripe -- --dup             # the same event twice: second answer is duplicate: true
npm run send:generic                     # a signed generic event
```

Open <http://localhost:3000/dashboard> and watch retries happen, then succeed or land in the dead-letter
list with a **Replay** button. The Google Sheets connector stays off until its three settings are filled
in; see `.env.example`.

| Endpoint | Purpose |
|---|---|
| `POST /webhooks/stripe` | Stripe events, verified with `STRIPE_WEBHOOK_SECRET` |
| `POST /webhooks/generic` | Any sender using `X-Timestamp` + `X-Signature: sha256=…` |
| `GET /dashboard` | Recent events, delivery status, dead-letter list, replay |
| `GET /api/deliveries?status=dead` | The same data as JSON |
| `POST /api/deliveries/:id/replay` | Replay one dead delivery |
| `GET /health` | DB check; `503` while shutting down so load balancers drain first |
| `GET /metrics` | Prometheus: webhooks by result, attempts by outcome, latency, queue depth |

Logs are one JSON object per line (pino), with `requestId`, `eventId`, `deliveryId`, `connector` and
`attempt` on every line they apply to. Signature headers and secrets are redacted. Pipe through
`npx pino-pretty` when reading locally.

On `SIGTERM` the service fails its health check, stops accepting requests, stops claiming jobs, waits up
to `SHUTDOWN_TIMEOUT_MS` for in-flight deliveries, then closes the pool. Anything still running after that
is aborted and picked up again after its lease expires.

## Testing

```bash
npm test               # unit + integration
npm run test:unit      # no database needed
npm run test:int       # needs Postgres (see below)
npm run lint && npm run typecheck
```

Integration tests run against real Postgres, because the interesting behaviour (`SKIP LOCKED`, unique
constraints, transactions, leases) only exists there. They use `TEST_DATABASE_URL` when it is set
(`postgres://hub:hub@localhost:5433/hub_test` with the compose file), and otherwise start a throwaway
container with Testcontainers. No real credentials are needed: connectors are tested with a fake `fetch`.

What is covered, among others:

- **Signatures:** valid, wrong secret, tampered body, stale timestamp, missing or malformed header, key
  rotation with several `v1` signatures.
- **Idempotency:** repeated and concurrent copies of one webhook store one event; the same idempotency key
  on every retry; Sheets skips a row it already wrote.
- **Queue:** concurrent claims never overlap, retries are not handed out early, dead-letter after max
  attempts, permanent errors skip retries, lease expiry recovery, stale-worker fencing.
- **Backoff:** exponential growth, cap, jitter range, `Retry-After` precedence.
- **DLQ replay:** replay from the queue, the dashboard button and the API; double replay is a no-op.
- **Worker:** per-connector rate limits, concurrency limit, one failing connector does not block another,
  graceful shutdown with and without timeout.
- **HTTP:** health during shutdown, metrics output, HTML escaping, CSRF on dashboard forms, basic auth.

CI runs lint, typecheck, build and the full suite against a Postgres service container on every push.

## How I deliver this kind of work for clients

I'm Noam, a senior engineer with 17+ years of building backend systems. Integration work is most of what
I do, and it goes the same way each time.

1. **Scoped milestones.** We start with a short written scope: which events, which destinations, which
   fields map where, and what should happen when each side fails. Each milestone ends in something you
   can run, such as "Stripe checkouts appear in the Sheet, retries included".
2. **Tests first.** Before writing a connector I write the tests for the cases that cause incidents:
   duplicates, timeouts, rate limits, bad payloads. You get those tests, and they keep running in CI after
   I hand over.
3. **A pull request per feature.** Small reviewable PRs with a description of what changed and how it was
   tested. You can follow progress in your own repository, not in status emails.
4. **A handover document.** At the end you get a page your team can operate from: how to deploy, where
   the logs and metrics are, what each alert means, how to replay failed deliveries, and how to add the
   next connector.

## License

[MIT](LICENSE) © 2026 Noam Tzuberi
