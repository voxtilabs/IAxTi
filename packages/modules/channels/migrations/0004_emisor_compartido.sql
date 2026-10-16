-- #74: un sender de Zavu tiene UN webhook, aunque transporte varios canales.
-- La reserva conserva dueño y receptor primario también al archivar un canal.
ALTER TABLE channel_accounts ADD CONSTRAINT channel_accounts_id_tenant_unique UNIQUE (id, tenant_id);
CREATE TABLE channel_senders (
  sender_id text PRIMARY KEY CHECK (length(sender_id) > 0),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  webhook_account_id uuid,
  FOREIGN KEY (webhook_account_id, tenant_id) REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX channel_senders_tenant_idx ON channel_senders (tenant_id);
ALTER TABLE channel_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_senders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_senders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Nunca elegir silenciosamente al dueño de datos inconsistentes.
DO $$ BEGIN
  IF EXISTS (
    SELECT config->>'senderId' FROM channel_accounts
    WHERE kind IN ('whatsapp', 'instagram', 'messenger') AND COALESCE(config->>'senderId', '') <> ''
    GROUP BY config->>'senderId' HAVING count(DISTINCT tenant_id) > 1
  ) THEN
    RAISE EXCEPTION 'Un emisor pertenece a varios tenants; revisar antes de aplicar channels/0004';
  END IF;
END $$;
INSERT INTO channel_senders (sender_id, tenant_id, webhook_account_id)
SELECT config->>'senderId', tenant_id,
       CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
FROM channel_accounts
WHERE kind IN ('whatsapp', 'instagram', 'messenger') AND COALESCE(config->>'senderId', '') <> ''
GROUP BY config->>'senderId', tenant_id;
-- Con varias cuentas del mismo sender no sabemos a cuál apunta Zavu. Se
-- conserva dueño e ingreso histórico, sin receptor; la acreditación queda pendiente
-- de que el operador compruebe el receptor real, nunca por antigüedad/estado.

-- Oráculo mínimo como tenant_de_cuenta_de_canal: no entrega nombres ni refs.
CREATE FUNCTION tenant_de_emisor_de_canal(p_sender_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $$
  SELECT tenant_id FROM public.channel_senders WHERE sender_id = p_sender_id
$$;
REVOKE ALL ON FUNCTION tenant_de_emisor_de_canal(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON channel_senders TO iaxti_app;
    GRANT EXECUTE ON FUNCTION tenant_de_emisor_de_canal(text) TO iaxti_app;
  END IF;
END $$;
