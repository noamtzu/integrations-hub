import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Pool } from "../db/pool.js";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

interface EventRow {
  id: number;
  source: string;
  external_id: string;
  type: string;
  received_at: Date;
  deliveries: Array<{ id: number; connector: string; status: string; attempts: number }> | null;
}

interface DeadRow {
  id: number;
  event_id: number;
  connector: string;
  attempts: number;
  last_error: string | null;
  updated_at: Date;
  type: string;
  external_id: string;
}

const STYLE = `
  :root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e4e4df;
          --ok:#1f7a4d; --warn:#9a6700; --bad:#b42318; --accent:#2f5bd3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141413; --fg:#ececea; --muted:#9b9b95; --card:#1d1d1b; --line:#2e2e2b;
            --ok:#4cc38a; --warn:#e3b341; --bad:#f97066; --accent:#7c9cff; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; } header a { color:var(--muted); text-decoration:none; }
  main { padding:24px; max-width:1200px; margin:0 auto; display:grid; gap:24px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .tile .n { font-size:24px; font-weight:600; font-variant-numeric:tabular-nums; }
  .tile .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  section h2 { font-size:14px; margin:0; padding:12px 14px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 14px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td.err { white-space:normal; max-width:420px; color:var(--bad); font-family:ui-monospace,monospace; font-size:12px; }
  code { font-family:ui-monospace,monospace; font-size:12px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid currentColor; margin-right:4px; }
  .succeeded { color:var(--ok); } .pending, .running { color:var(--warn); } .dead { color:var(--bad); }
  button { font:inherit; padding:4px 10px; border-radius:6px; border:1px solid var(--accent); background:transparent; color:var(--accent); cursor:pointer; }
  button:hover { background:var(--accent); color:var(--card); }
  .empty { padding:16px 14px; color:var(--muted); }
  a { color:var(--accent); }
`;

const time = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

function layout(title: string, body: Html): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="refresh" content="10" />
        <title>${title} · integrations-hub</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <header>
          <h1>integrations-hub</h1>
          <a href="/dashboard">Overview</a>
          <a href="/health">/health</a>
          <a href="/metrics">/metrics</a>
        </header>
        <main>${body}</main>
      </body>
    </html>`;
}

function replayButton(deliveryId: number): Html {
  return html`<form method="post" action="/dashboard/deliveries/${deliveryId}/replay" style="margin:0">
    <button type="submit">Replay</button>
  </form>`;
}

export async function renderOverview(pool: Pool): Promise<Html> {
  const [counts, events, dead] = await Promise.all([
    pool.query<{ status: string; count: number }>(
      "SELECT status, count(*)::int AS count FROM deliveries GROUP BY status",
    ),
    pool.query<EventRow>(
      `SELECT e.id, e.source, e.external_id, e.type, e.received_at,
              json_agg(json_build_object('id', d.id, 'connector', d.connector, 'status', d.status, 'attempts', d.attempts)
                       ORDER BY d.connector) FILTER (WHERE d.id IS NOT NULL) AS deliveries
         FROM events e LEFT JOIN deliveries d ON d.event_id = e.id
        GROUP BY e.id ORDER BY e.received_at DESC LIMIT 50`,
    ),
    pool.query<DeadRow>(
      `SELECT d.id, d.event_id, d.connector, d.attempts, d.last_error, d.updated_at, e.type, e.external_id
         FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.status = 'dead' ORDER BY d.updated_at DESC LIMIT 50`,
    ),
  ]);
  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.count]));
  const tile = (label: string, key: string) =>
    html`<div class="tile"><div class="n ${key}">${byStatus[key] ?? 0}</div><div class="l">${label}</div></div>`;

  return layout(
    "Overview",
    html`
      <div class="tiles">
        ${tile("Pending", "pending")} ${tile("Running", "running")} ${tile("Delivered", "succeeded")}
        ${tile("Dead-letter", "dead")}
      </div>

      <section>
        <h2>
          <span>Dead-letter list (${dead.rows.length})</span>
          ${dead.rows.length > 0
            ? html`<form method="post" action="/dashboard/replay-dead" style="margin:0">
                <button type="submit">Replay all</button>
              </form>`
            : ""}
        </h2>
        ${dead.rows.length === 0
          ? html`<div class="empty">Nothing here. Every delivery either succeeded or is still being retried.</div>`
          : html`<div class="scroll"><table>
              <tr><th>Delivery</th><th>Event</th><th>Connector</th><th>Attempts</th><th>Last error</th><th>Failed at</th><th></th></tr>
              ${dead.rows.map(
                (d) => html`<tr>
                  <td>#${d.id}</td>
                  <td><a href="/dashboard/events/${d.event_id}">${d.type}</a><br /><code>${d.external_id}</code></td>
                  <td>${d.connector}</td>
                  <td>${d.attempts}</td>
                  <td class="err">${d.last_error ?? ""}</td>
                  <td>${time(d.updated_at)}</td>
                  <td>${replayButton(d.id)}</td>
                </tr>`,
              )}
            </table></div>`}
      </section>

      <section>
        <h2><span>Recent events</span></h2>
        ${events.rows.length === 0
          ? html`<div class="empty">No events yet. Send one with <code>npm run send:stripe</code>.</div>`
          : html`<div class="scroll"><table>
              <tr><th>#</th><th>Received</th><th>Source</th><th>Type</th><th>Source id</th><th>Deliveries</th></tr>
              ${events.rows.map(
                (e) => html`<tr>
                  <td><a href="/dashboard/events/${e.id}">${e.id}</a></td>
                  <td>${time(e.received_at)}</td>
                  <td>${e.source}</td>
                  <td>${e.type}</td>
                  <td><code>${e.external_id}</code></td>
                  <td>
                    ${(e.deliveries ?? []).map(
                      (d) => html`<span class="pill ${d.status}" title="${d.attempts} attempt(s)">${d.connector}: ${d.status}</span>`,
                    )}
                    ${e.deliveries ? "" : html`<span style="color:var(--muted)">no matching connector</span>`}
                  </td>
                </tr>`,
              )}
            </table></div>`}
      </section>
    `,
  );
}

export async function renderEvent(pool: Pool, eventId: number): Promise<Html | null> {
  const event = await pool.query<{
    id: number; source: string; external_id: string; type: string; payload: unknown; received_at: Date;
  }>("SELECT id, source, external_id, type, payload, received_at FROM events WHERE id = $1", [eventId]);
  const e = event.rows[0];
  if (!e) return null;

  const deliveries = await pool.query<{
    id: number; connector: string; status: string; attempts: number; max_attempts: number;
    run_at: Date; last_error: string | null;
    history: Array<{ attempt: number; outcome: string; error: string | null; duration_ms: number; created_at: string }> | null;
  }>(
    `SELECT d.id, d.connector, d.status, d.attempts, d.max_attempts, d.run_at, d.last_error,
            (SELECT json_agg(a ORDER BY a.id) FROM delivery_attempts a WHERE a.delivery_id = d.id) AS history
       FROM deliveries d WHERE d.event_id = $1 ORDER BY d.connector`,
    [eventId],
  );

  return layout(
    `Event ${e.id}`,
    html`
      <section>
        <h2><span>Event #${e.id} · ${e.type}</span><span>${e.source} · <code>${e.external_id}</code></span></h2>
        <pre style="margin:0;padding:14px;overflow:auto;max-height:320px"><code>${JSON.stringify(e.payload, null, 2)}</code></pre>
      </section>
      ${deliveries.rows.map(
        (d) => html`<section>
          <h2>
            <span>${d.connector} <span class="pill ${d.status}">${d.status}</span> attempt ${d.attempts}/${d.max_attempts}</span>
            ${d.status === "dead" ? replayButton(d.id) : d.status === "pending" ? html`<span>next try ${time(d.run_at)}</span>` : ""}
          </h2>
          <div class="scroll"><table>
            <tr><th>Attempt</th><th>Outcome</th><th>Duration</th><th>At</th><th>Error</th></tr>
            ${(d.history ?? []).map(
              (a) => html`<tr>
                <td>${a.attempt}</td>
                <td><span class="pill ${a.outcome === "retry" ? "pending" : a.outcome}">${a.outcome}</span></td>
                <td>${a.duration_ms} ms</td>
                <td>${time(new Date(a.created_at))}</td>
                <td class="err">${a.error ?? ""}</td>
              </tr>`,
            )}
          </table></div>
        </section>`,
      )}
    `,
  );
}
