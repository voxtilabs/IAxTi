-- Outbox transaccional y registro de consumo idempotente (SPEC §26 regla 6).
-- Tablas de plataforma: el sobre lleva tenant_id pero el despachador las lee
-- cross-tenant con el rol de workers; el rol de aplicación solo INSERTa en
-- outbox (dentro de la transacción del caso de uso) y no las consulta.
CREATE TABLE IF NOT EXISTS outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text        NOT NULL,
  tenant_id    uuid        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  actor        text,
  request_id   text,
  version      int         NOT NULL DEFAULT 1,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     int         NOT NULL DEFAULT 0,
  last_error   text
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS processed_events (
  consumer     text   NOT NULL,
  event_id     bigint NOT NULL REFERENCES outbox(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
