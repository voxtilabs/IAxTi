-- Solo metadata y caché personal efímera; los tokens pertenecen a Secret Manager.
CREATE TABLE gmail_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  mailbox_hash text,
  grant_generation bigint NOT NULL,
  last_history numeric(40,0) NOT NULL DEFAULT 0,
  watch_expires_at timestamptz,
  last_watch_attempt_at timestamptz,
  last_notification_at timestamptz,
  UNIQUE(tenant_id,user_id)
);
CREATE INDEX gmail_connections_mailbox_idx ON gmail_connections(mailbox_hash) WHERE mailbox_hash IS NOT NULL;
CREATE TABLE gmail_thread_cache (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES gmail_connections(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  email_hash text NOT NULL,
  grant_generation bigint NOT NULL,
  history_id numeric(40,0) NOT NULL,
  summaries jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,connection_id,contact_id)
);
DO $$ DECLARE tabla text; BEGIN
  FOREACH tabla IN ARRAY ARRAY['gmail_connections','gmail_thread_cache'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tabla);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tabla);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',tabla);
  END LOOP;
END $$;
-- Únicamente después de verificar OIDC Pub/Sub. No devuelve usuarios, buzones,
-- grant ni secretos; solo IDs para abrir las transacciones RLS del fan-out.
CREATE FUNCTION tenants_del_buzon_gmail(p_hash text) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT DISTINCT g.tenant_id FROM public.gmail_connections g WHERE g.mailbox_hash=p_hash AND p_hash ~ '^[0-9a-f]{64}$'
$$;
CREATE FUNCTION tenants_con_mantenimiento_gmail(p_now timestamptz) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT DISTINCT g.tenant_id FROM public.gmail_connections g JOIN public.tenants t ON t.id=g.tenant_id
 WHERE COALESCE(t.state,'active') IN ('active','trial','past_due') AND
 (g.watch_expires_at IS NULL OR g.watch_expires_at<p_now+interval '1 day' OR EXISTS(
 SELECT 1 FROM public.gmail_thread_cache c WHERE c.tenant_id=g.tenant_id AND c.connection_id=g.id AND c.expires_at<=p_now))
$$;
REVOKE ALL ON FUNCTION tenants_del_buzon_gmail(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenants_con_mantenimiento_gmail(timestamptz) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
  GRANT EXECUTE ON FUNCTION tenants_del_buzon_gmail(text),tenants_con_mantenimiento_gmail(timestamptz) TO iaxti_app;
 END IF;
END $$;
-- La limpieza local no depende del estado/plan ni del módulo encendido.
CREATE INDEX gmail_thread_cache_expiry_idx ON gmail_thread_cache(expires_at,tenant_id);
CREATE FUNCTION tenants_con_cache_gmail_vencida(p_now timestamptz) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT DISTINCT c.tenant_id FROM public.gmail_thread_cache c WHERE c.expires_at<=p_now
$$;
REVOKE ALL ON FUNCTION tenants_con_cache_gmail_vencida(timestamptz) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
  GRANT EXECUTE ON FUNCTION tenants_con_cache_gmail_vencida(timestamptz) TO iaxti_app;
 END IF;
END $$;
