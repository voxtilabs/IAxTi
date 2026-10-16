-- ADR-0026: preselección sin transacción por negocio vacío. Solo devuelve IDs.
CREATE FUNCTION tenants_con_limpieza_google() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT a.tenant_id FROM public.google_oauth_attempts a WHERE a.expires_at<=now()
  UNION
  SELECT v.tenant_id FROM public.google_secret_versions v
  WHERE v.destroy_pending AND (NOT v.whole_secret OR v.created_at<now()-interval '15 minutes')
    AND NOT EXISTS(SELECT 1 FROM public.google_oauth_grants g WHERE g.tenant_id=v.tenant_id AND g.status<>'revoked'
      AND (g.secret_ref=v.secret_ref OR (v.whole_secret AND g.secret_ref LIKE '%/secrets/'||v.secret_ref||'/versions/%')))
$$;
REVOKE ALL ON FUNCTION tenants_con_limpieza_google() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_limpieza_google() TO iaxti_app;
  END IF;
END $$;
