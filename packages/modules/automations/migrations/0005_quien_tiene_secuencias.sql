-- Preguntar UNA vez quién tiene un paso de secuencia vencido (#740, ADR-0026).
--
-- `sweepSequences` recorría TODOS los tenants vivos y, por cada uno, abría una
-- transacción para consultar sus inscripciones vencidas. Eso vino de #286 y fue
-- correcto: una consulta suelta a `sequence_enrollments` —que tiene RLS—
-- devuelve cero filas con el rol de producción.
--
-- Medido el 09/10 en una base con 1.283 tenants: visitar uno SIN trabajo cuesta
-- 4,5 ms, así que el barrido entero son ~5,8 s. Proyectado a mil tenants con la
-- base a 64 ms de distancia (#711): minutos de un cron haciendo nada. Y este
-- tick corre cada pocos minutos, como el de recordatorios.
--
-- Es el CUARTO barrido de esta familia —facturación (#580), recordatorios y
-- reglas (#733), muestras (#738)— y no salió en el tercero porque esa noche la
-- base tenía menos tenants y estas pruebas entraban justo dentro del límite de
-- vitest. Cada corrida de las suites agrega tenants: el problema se fue haciendo
-- visible solo.
--
-- Acotaciones de ADR-0026: sale una lista de ids y nada más, `search_path` fijo,
-- `EXECUTE` concedido explícitamente, y el tick sigue entrando a cada tenant con
-- `withTenant`.
--
-- SIN parámetro, al revés que la de recordatorios (#733): ésa lo necesita porque
-- su barrido acepta un reloj inyectado para poder probarse, y con `now()` en el
-- SQL el filtro y la regla discrepaban. `sweepSequences` no tiene reloj
-- inyectado —usa `now()` en su propia consulta—, así que las dos miran el mismo
-- y no hay nada en qué discrepar. Agregar el parámetro «por si acaso» sería
-- ensanchar la función sin un motivo que exista hoy.
--
-- Lo que la función NO hace es decidir el paso. Qué paso toca, si el cliente ya
-- respondió (`onlyIfNoReply`), si la secuencia sigue encendida y si la ventana de
-- 24 h lo permite lo sigue decidiendo el tick con sus reglas. Acá solo se filtra
-- a quién mirar.

CREATE OR REPLACE FUNCTION tenants_con_secuencias_vencidas()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT e.tenant_id
    FROM sequence_enrollments e
    JOIN tenants t ON t.id = e.tenant_id
   WHERE e.status = 'running'
     AND e.next_run_at <= now()
     AND COALESCE(t.state, 'active') <> 'deleted';
$$;

REVOKE ALL ON FUNCTION tenants_con_secuencias_vencidas() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_secuencias_vencidas() TO iaxti_app;
  END IF;
END $$;
