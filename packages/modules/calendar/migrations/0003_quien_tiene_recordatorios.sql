-- Preguntar UNA vez quién tiene citas por recordar (#733, ADR-0026).
--
-- `barrerRecordatorios` recorría TODOS los tenants vivos y, por cada uno, abría
-- una transacción y corría una consulta por cada aviso de `AVISOS`. Eso vino de
-- #286 y fue correcto: una consulta suelta a `appointments` —que tiene RLS—
-- devuelve cero filas con el rol de producción.
--
-- Medido el 09/10 en una base con 1.283 tenants: visitar uno SIN trabajo cuesta
-- 4,5 ms, así que el barrido entero son ~5,8 s. Proyectado a mil tenants con la
-- base a 64 ms de distancia (#711): minutos de un cron haciendo nada. Y este
-- barrido corre cada pocos minutos, no una vez al día.
--
-- La ventana de acá es DELIBERADAMENTE más amplia que la del barrido: cualquier
-- cita confirmada en las próximas 25 horas. El barrido decide con `AVISOS` cuál
-- aviso corresponde y cuál ya salió. Duplicar los minutos exactos de cada aviso
-- en SQL los pondría en dos lugares, y el día que se agregue un aviso de 48 h
-- —o se mueva el de 2— la función quedaría vieja y los recordatorios de esos
-- tenants no saldrían nunca. Es el defecto que esta semana salió nueve veces:
-- declarado en un lado, aplicado en ninguno.
--
-- Las 25 horas son las 24 del aviso más lejano más una de holgura: la ventana
-- del barrido mira una hora hacia atrás —«si el barrido se cae y se levanta
-- cuarenta minutos después, el recordatorio igual sale»— y una ventana justa de
-- 24 h acá dejaría fuera justo a las citas que ese margen rescata.
--
-- Forma y acotaciones como en ADR-0026: sale una lista de ids y nada más,
-- `search_path` fijo, `EXECUTE` concedido explícitamente, y el barrido sigue
-- entrando a cada tenant con `withTenant`.
--
-- CON UNA DIFERENCIA: ésta SÍ acepta un parámetro, el instante de referencia. La
-- de facturación no lo necesita; ésta sí, y el motivo es que el barrido acepta
-- un reloj inyectado (`ahora`) para poder probarse. Si el filtro usara `now()` y
-- el barrido evaluara con otro instante, **el filtro y la regla discreparían**:
-- el barrido no vería al tenant que sí tenía una cita para su reloj. Lo cazó una
-- prueba, y tenía razón — un filtro que solo acierta en producción es la clase de
-- cosa que después nadie entiende.
--
-- El parámetro no abre nada que el rol de la aplicación no pudiera ya: ese rol
-- fija `app.tenant_id` él mismo en cada transacción, así que RLS lo protege de
-- errores y de inyección, no de sí mismo. Sigue saliendo una lista de ids.

-- Sin argumentos nunca existió en ningún ambiente desplegado; el DROP está para
-- las bases de desarrollo que alcanzaron a correr la primera versión de ESTA
-- migración, donde `CREATE OR REPLACE` no sirve: cambiar la firma crea otra
-- función en vez de reemplazarla, y quedarían las dos.
DROP FUNCTION IF EXISTS tenants_con_citas_por_recordar();

CREATE OR REPLACE FUNCTION tenants_con_citas_por_recordar(p_ahora timestamptz DEFAULT now())
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT a.tenant_id
    FROM appointments a
    JOIN tenants t ON t.id = a.tenant_id
   WHERE a.status IN ('confirmed', 'reminded')
     AND a.starts_at > p_ahora - interval '1 hour'
     AND a.starts_at <= p_ahora + interval '25 hours'
     AND COALESCE(t.state, 'active') <> 'deleted';
$$;

REVOKE ALL ON FUNCTION tenants_con_citas_por_recordar(timestamptz) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_citas_por_recordar(timestamptz) TO iaxti_app;
  END IF;
END $$;
