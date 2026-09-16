-- Envíos segmentados (#75, SPEC §15).
--
-- "Mándale la promo a todos los que cotizaron y no compraron." Es lo que
-- pide un negocio con cartera, y es también la forma más rápida de que a
-- alguien lo bloqueen en WhatsApp. Por eso cada destinatario tiene su fila:
-- no se puede saber si una campaña salió bien mirando un contador.
CREATE TABLE IF NOT EXISTS segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL,
  -- Los filtros tal cual los arma la interfaz: etiqueta, etapa, días sin
  -- actividad, campo personalizado.
  filters    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'segments') THEN
    CREATE POLICY tenant_isolation ON segments
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text NOT NULL,
  template_id  uuid NOT NULL,
  -- Los filtros quedan CONGELADOS en la campaña: si el segmento cambia
  -- después, la campaña que salió no cambia de destinatarios hacia atrás.
  filters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Los valores de las variables de la plantilla, por posición. Los que
  -- salen del contacto van como {contacto.nombre}.
  values       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','sending','done','cancelled')),
  created_by   uuid,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_tenant_idx ON campaigns (tenant_id, created_at DESC);
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'campaigns') THEN
    CREATE POLICY tenant_isolation ON campaigns
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Una fila por destinatario, con el resultado y el MOTIVO si no se le
-- mandó. Un "enviados: 120 de 200" sin decir qué pasó con los 80 obliga a
-- adivinar, y lo que se adivina es siempre lo más cómodo.
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  message_id  uuid,
  status      text NOT NULL
              CHECK (status IN ('queued','skipped','failed')),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- La misma persona no recibe la misma campaña dos veces, aunque el
  -- disparo se repita.
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS campaign_recipients_idx
  ON campaign_recipients (tenant_id, campaign_id, status);
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'campaign_recipients') THEN
    CREATE POLICY tenant_isolation ON campaign_recipients
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
