-- ADR-0026: el cron no abre transacciones para todos los tenants.
CREATE FUNCTION tenants_con_mantenimiento_google(p_now timestamptz) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT candidates.tenant_id FROM (
    SELECT c.tenant_id FROM public.calendar_connections c WHERE NOT EXISTS(
      SELECT 1 FROM public.calendar_google_watches w WHERE w.connection_id=c.id
        AND w.resource_id IS NOT NULL AND w.expires_at>p_now+interval '1 hour')
    UNION
    SELECT f.tenant_id FROM public.calendar_freebusy_cache f WHERE f.expires_at<=p_now
  ) candidates JOIN public.tenants t ON t.id=candidates.tenant_id
  WHERE COALESCE(t.state,'active') IN ('active','trial','past_due')
$$;
REVOKE ALL ON FUNCTION tenants_con_mantenimiento_google(timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_mantenimiento_google(timestamptz) TO iaxti_app;
  END IF;
END $$;
