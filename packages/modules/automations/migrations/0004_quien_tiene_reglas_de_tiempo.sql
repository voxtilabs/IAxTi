-- Preguntar UNA vez quién tiene reglas de tiempo (#733, ADR-0026).
--
-- `sweepTimeRules` recorría TODOS los tenants vivos y, por cada uno, abría una
-- transacción, leía su zona horaria y consultaba sus reglas. Eso vino de #286 y
-- fue correcto: una consulta suelta a `rules` —que tiene RLS— devuelve cero
-- filas con el rol de producción.
--
-- Medido el 09/10 en una base con 1.283 tenants: visitar uno SIN trabajo cuesta
-- 4,5 ms, así que el barrido entero son ~5,8 s. Proyectado a mil tenants con la
-- base a 64 ms de distancia (#711): minutos de un cron haciendo nada. Y la
-- mayoría de los negocios no tiene NINGUNA regla de tiempo activa.
--
-- Misma forma que `tenants_con_trabajo_de_facturacion` (#580) y por los mismos
-- motivos, que están escritos en ADR-0026:
--
--   * Sale una lista de IDS DE TENANT y nada más. `tenants` no tiene RLS, así
--     que esos ids ya son visibles para el rol de la aplicación: lo único que
--     agrega es cuáles tienen una regla de tiempo encendida.
--   * NO acepta parámetros.
--   * `SET search_path = public`.
--   * El EXECUTE se concede explícitamente.
--
-- El barrido sigue entrando a cada tenant con `withTenant`: esto decide A QUIÉN
-- visitar, y lo que se lee y escribe sigue pasando por RLS. Si devolviera uno de
-- más, no encontraría reglas y no haría nada.
--
-- Lo que la función NO hace es evaluar la regla. Qué conversaciones califican, en
-- qué día del negocio y con qué dedupe, lo decide el barrido con la zona horaria
-- del tenant. Meter eso acá sería duplicar la lógica en SQL y en TypeScript.

CREATE OR REPLACE FUNCTION tenants_con_reglas_de_tiempo()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT r.tenant_id
    FROM rules r
    JOIN tenants t ON t.id = r.tenant_id
   WHERE r.active
     AND r.trigger->>'kind' = 'time'
     AND COALESCE(t.state, 'active') <> 'deleted';
$$;

REVOKE ALL ON FUNCTION tenants_con_reglas_de_tiempo() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_reglas_de_tiempo() TO iaxti_app;
  END IF;
END $$;
