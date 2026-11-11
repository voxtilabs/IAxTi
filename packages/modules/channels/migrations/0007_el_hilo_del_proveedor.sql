-- El hilo de cada conversación del lado del proveedor (ADR-0033, #1334).
--
-- Zernio manda DENTRO de una conversación que ya existe, no a un teléfono. El
-- id de esa conversación —el «hilo»— se aprende de cada mensaje que entra y
-- se usa para contestar. Vive en `channels` y no en `conversations` porque es
-- un dato del TRANSPORTE y de la CUENTA: si una conversación nuestra pasa de
-- una cuenta a otra, el hilo no viaja con ella.
--
-- `peer` es el teléfono en E.164 mientras todo IAxTi identifique así a los
-- contactos; un mensaje sin teléfono (BSUID de Meta) no llega hasta acá (#1331).
--
-- FK compuesta a `channel_accounts (id, tenant_id)`, la de `channel_senders`
-- (0004): un hilo no puede apuntar a la cuenta de OTRO tenant aunque alguien
-- se equivoque de id. ON DELETE CASCADE porque un hilo sin su cuenta no sirve
-- para nada y no es un dato del negocio.
CREATE TABLE IF NOT EXISTS channel_threads (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  channel_account_id uuid NOT NULL,
  peer               text NOT NULL,
  provider_thread_id text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_account_id, peer),
  -- En UNA línea, como la de channel_senders: el escáner de columnas sin
  -- lector lee por línea y una continuación que empieza con REFERENCES la toma
  -- por columna.
  FOREIGN KEY (channel_account_id, tenant_id) REFERENCES channel_accounts (id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE channel_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_threads FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'channel_threads') THEN
    CREATE POLICY tenant_isolation ON channel_threads
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON channel_threads TO iaxti_app;
  END IF;
END $$;
