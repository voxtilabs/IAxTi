-- #57: la identidad del consentimiento es personal; Calendar sigue siendo
-- Base aunque Drive/Gmail (integrations) estén apagados. Solo REFERENCIAS a
-- Secret Manager: ningún access/refresh token, código o verifier en Postgres.
CREATE TABLE google_oauth_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  state_hash text NOT NULL UNIQUE,
  challenge text NOT NULL,
  nonce_hash text NOT NULL,
  service text NOT NULL CHECK (service IN ('calendar')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_oauth_attempts_tenant_idx ON google_oauth_attempts(tenant_id, user_id);
ALTER TABLE google_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_oauth_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON google_oauth_attempts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE google_oauth_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  client_id text NOT NULL,
  google_subject text NOT NULL,
  secret_ref text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoking','revoked','reauth_required')),
  generation integer NOT NULL DEFAULT 1,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,user_id)
);
CREATE INDEX google_oauth_grants_account_idx ON google_oauth_grants(client_id,google_subject);
ALTER TABLE google_oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_oauth_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON google_oauth_grants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Referencias de versiones, nunca sus payloads. La destrucción es durable:
-- si GCP falla después del commit se vuelve a intentar en el worker.
CREATE TABLE google_secret_versions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  secret_ref text PRIMARY KEY,
  destroy_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_secret_versions_pending_idx ON google_secret_versions(tenant_id,destroy_pending);
ALTER TABLE google_secret_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_secret_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON google_secret_versions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Google revoca todo el grant del proyecto para esa cuenta, incluso si se
-- conectó en otro negocio. La fuente siempre es un grant PROPIO del actor y
-- tenant autenticados. El resultado es interno: sirve para auditar cada
-- tenant en la misma transacción, jamás se devuelve por la API.
CREATE FUNCTION google_grants_para_revocar(p_grant uuid, p_actor uuid)
RETURNS TABLE(id uuid, tenant_id uuid, user_id uuid, secret_ref text, generation integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $$
DECLARE fuente public.google_oauth_grants;
BEGIN
  SELECT * INTO fuente FROM public.google_oauth_grants g
    WHERE g.id=p_grant AND g.user_id=p_actor
      AND g.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('google:' || fuente.client_id || ':' || fuente.google_subject,0));
  RETURN QUERY UPDATE public.google_oauth_grants g
    SET status='revoking', generation=g.generation+1, updated_at=now()
    WHERE g.client_id=fuente.client_id AND g.google_subject=fuente.google_subject
      AND g.status IN ('active','reauth_required','revoking')
    RETURNING g.id,g.tenant_id,g.user_id,g.secret_ref,g.generation;
END $$;
REVOKE ALL ON FUNCTION google_grants_para_revocar(uuid,uuid) FROM PUBLIC;

-- La cuenta viene de un ID token verificado, nunca de un parámetro de la
-- pantalla. Impide reconectar mientras una revocación remota incierta sigue
-- pendiente; una respuesta tardía no debe revocar un consentimiento nuevo.
CREATE FUNCTION google_revocacion_pendiente(p_client text,p_subject text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off AS $$
  SELECT EXISTS(SELECT 1 FROM public.google_oauth_grants
    WHERE client_id=p_client AND google_subject=p_subject AND status='revoking')
$$;
REVOKE ALL ON FUNCTION google_revocacion_pendiente(text,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION google_grants_para_revocar(uuid,uuid) TO iaxti_app;
    GRANT EXECUTE ON FUNCTION google_revocacion_pendiente(text,text) TO iaxti_app;
  END IF;
END $$;
