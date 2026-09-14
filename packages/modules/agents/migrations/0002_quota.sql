-- Cuota de IA (#52): los umbrales se avisan UNA vez por ciclo y nivel, y
-- el 100 % pausa el modo autónomo (se despega con la reactivación o el
-- ciclo nuevo — nada vuelve solo a autónomo sin aviso).
CREATE TABLE IF NOT EXISTS agent_quota_alerts (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  period_start date NOT NULL,
  level        int  NOT NULL CHECK (level IN (80, 100)),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_start, level)
);
ALTER TABLE agent_quota_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_quota_alerts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_quota_alerts') THEN
    CREATE POLICY tenant_isolation ON agent_quota_alerts
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS autonomous_paused_at timestamptz;
