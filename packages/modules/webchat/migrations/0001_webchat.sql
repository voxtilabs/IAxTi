-- webchat (#46): el widget y sus sesiones de visitante.
CREATE TABLE IF NOT EXISTS webchat_widgets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- token público del snippet
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id),
  name               text NOT NULL DEFAULT 'Chat del sitio',
  allowed_domain     text NOT NULL, -- p. ej. tunegocio.cl; el widget valida el Origin
  welcome_message    text NOT NULL DEFAULT '¡Hola! ¿En qué te podemos ayudar?',
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webchat_widgets_tenant_idx ON webchat_widgets (tenant_id);
ALTER TABLE webchat_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE webchat_widgets FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'webchat_widgets') THEN
    CREATE POLICY tenant_isolation ON webchat_widgets
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- La sesión del visitante: anónima al primer mensaje (queda en pending),
-- identificada ANTES del segundo (SPEC §12) — ahí nace o se enlaza el
-- contacto y se abre la conversación.
CREATE TABLE IF NOT EXISTS webchat_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- vive en el navegador del visitante
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  widget_id       uuid NOT NULL REFERENCES webchat_widgets(id),
  contact_id      uuid REFERENCES contacts(id),
  conversation_id uuid REFERENCES conversations(id),
  visitor_name    text,
  pending         jsonb NOT NULL DEFAULT '[]'::jsonb, -- mensajes previos a la identificación
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webchat_sessions_widget_idx ON webchat_sessions (tenant_id, widget_id);
ALTER TABLE webchat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webchat_sessions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'webchat_sessions') THEN
    CREATE POLICY tenant_isolation ON webchat_sessions
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
