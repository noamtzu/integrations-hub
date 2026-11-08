-- Every inbound webhook we accepted. (source, external_id) is the inbound
-- idempotency key: a provider retry of the same event is a no-op.
CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  source       text        NOT NULL,
  external_id  text        NOT NULL,
  type         text        NOT NULL,
  payload      jsonb       NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_source_external_id_key UNIQUE (source, external_id)
);
CREATE INDEX events_received_at_idx ON events (received_at DESC);

-- One row per (event, connector): the durable job queue.
--   pending   -> waiting for run_at
--   running   -> claimed by a worker until locked_at + lease
--   succeeded -> done
--   dead      -> out of attempts or failed permanently (the dead-letter list)
CREATE TABLE deliveries (
  id              bigserial PRIMARY KEY,
  event_id        bigint      NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  connector       text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'succeeded', 'dead')),
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  idempotency_key text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT deliveries_event_connector_key UNIQUE (event_id, connector),
  CONSTRAINT deliveries_idempotency_key_key UNIQUE (idempotency_key)
);
-- The claim query only looks at runnable rows; keep that index small.
CREATE INDEX deliveries_runnable_idx ON deliveries (connector, run_at) WHERE status IN ('pending', 'running');
CREATE INDEX deliveries_dead_idx ON deliveries (updated_at DESC) WHERE status = 'dead';

-- Audit trail: one row per attempt, so a failure can be explained later.
CREATE TABLE delivery_attempts (
  id           bigserial PRIMARY KEY,
  delivery_id  bigint      NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  attempt      integer     NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('succeeded', 'retry', 'dead')),
  error        text,
  duration_ms  integer     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts (delivery_id, attempt);
