CREATE TABLE calendar_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  calendar_id text NOT NULL DEFAULT 'primary',
  revision bigint NOT NULL DEFAULT 0,
  last_notification_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,user_id)
);
CREATE TABLE calendar_google_watches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  resource_id text,
  expires_at timestamptz NOT NULL,
  last_message numeric(30,0) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_google_watches_connection_idx ON calendar_google_watches(tenant_id,connection_id,expires_at);
CREATE TABLE calendar_freebusy_cache (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  day date NOT NULL,
  timezone text NOT NULL,
  revision bigint NOT NULL,
  busy jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,connection_id,day)
);
DO $$ DECLARE tabla text; BEGIN
  FOREACH tabla IN ARRAY ARRAY['calendar_connections','calendar_google_watches','calendar_freebusy_cache'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tabla);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tabla);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',tabla);
  END LOOP;
END $$;

-- Google Calendar autentica las notificaciones mediante el channel token,
-- no mediante una firma HMAC del body (que llega vacío). Solo hashes en DB.
CREATE FUNCTION tenant_del_watch_google(p_id uuid,p_token_hash text,p_resource text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT tenant_id FROM public.calendar_google_watches
    WHERE id=p_id AND token_hash=p_token_hash AND resource_id=p_resource AND expires_at>now()
$$;
REVOKE ALL ON FUNCTION tenant_del_watch_google(uuid,text,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenant_del_watch_google(uuid,text,text) TO iaxti_app;
  END IF;
END $$;
