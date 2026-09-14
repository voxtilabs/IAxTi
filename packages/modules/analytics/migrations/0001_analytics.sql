-- analytics (#66, SPEC §19): contadores por día/tenant/métrica/dueño,
-- alimentados POR EVENTO desde el outbox — el dashboard solo suma filas.
CREATE TABLE IF NOT EXISTS daily_metrics (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  day        date NOT NULL,
  metric     text NOT NULL,
  -- uuid cero = el total del tenant; con dueño, la vista "por usuario".
  owner_id   uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  value      numeric(16,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, metric, owner_id)
);
ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_metrics FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_metrics') THEN
    CREATE POLICY tenant_isolation ON daily_metrics
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Muestras de primera respuesta (una por conversación): mediana y p90
-- reales sin barrer messages en vivo. Las llena un barrido horario.
CREATE TABLE IF NOT EXISTS response_samples (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL UNIQUE,
  owner_id        uuid,
  day             date NOT NULL,
  seconds         int NOT NULL,
  PRIMARY KEY (tenant_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS response_samples_day_idx ON response_samples (tenant_id, day);
ALTER TABLE response_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_samples FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'response_samples') THEN
    CREATE POLICY tenant_isolation ON response_samples
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
