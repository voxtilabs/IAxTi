-- Preguntar UNA vez quién tiene muestras por tomar (#738, ADR-0026).
--
-- `sweepResponseSamples` recorría TODOS los tenants vivos y abría una
-- transacción por cada uno para correr un `INSERT … SELECT` que, en la enorme
-- mayoría, no insertaba nada. Eso vino de #286 y fue correcto: una consulta
-- suelta a `conversations` —que tiene RLS— devuelve cero filas con el rol de
-- producción, y entonces el tablero del dueño se quedaba sin números sin que
-- nadie viera un error.
--
-- Medido el 09/10 en una base con 1.283 tenants: visitar uno SIN trabajo cuesta
-- 4,5 ms, así que el barrido entero son ~5,8 s. Proyectado a mil tenants con la
-- base a 64 ms de distancia (#711): minutos de un cron haciendo nada. Y éste es
-- HORARIO, así que el desperdicio se paga veinticuatro veces al día.
--
-- Tercera función de esta forma —después de facturación (#580) y recordatorios y
-- reglas (#733)— y las acotaciones son las de ADR-0026: sale una lista de ids y
-- nada más, `search_path` fijo, `EXECUTE` concedido explícitamente, y el barrido
-- sigue entrando a cada tenant con `withTenant`.
--
-- La ventana de 26 horas es la MISMA que usa el barrido, y está acá porque es la
-- condición entera: no hay un plazo que pueda quedar desincronizado como en
-- recordatorios, donde la función filtra con una ventana amplia y los minutos
-- exactos de cada aviso los decide `AVISOS`. Si algún día el barrido cambia su
-- ventana, esta función tiene que cambiar con él — y por eso el número va con un
-- comentario en los dos lados, no suelto.
--
-- Acepta el instante por el mismo motivo que la de recordatorios: para que el
-- filtro y el barrido no puedan discrepar si alguna vez se le inyecta un reloj.
--
-- VIVE ACÁ Y NO EN `analytics`, aunque la llame su barrido: la tabla es de
-- `conversations`. Lo intenté al revés y CI lo cazó —«relation "conversations"
-- does not exist»— porque el runner aplica las migraciones en orden topológico
-- de dependencias y `analytics` no depende de `conversations`: sus migraciones
-- corren antes de que la tabla exista. En local no se veía porque la tabla ya
-- estaba de corridas anteriores, que es exactamente la clase de diferencia que
-- el script de pre-push no puede ver.
--
-- La función solo tiene que existir cuando el CÓDIGO la llama, no cuando corre
-- la migración de analytics. Y acá es donde corresponde: quien sabe qué es una
-- conversación respondida es este módulo.

CREATE OR REPLACE FUNCTION tenants_con_muestras_por_tomar(p_ahora timestamptz DEFAULT now())
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT c.tenant_id
    FROM conversations c
    JOIN tenants t ON t.id = c.tenant_id
   WHERE c.first_response_at > p_ahora - interval '26 hours'
     AND COALESCE(t.state, 'active') <> 'deleted';
$$;

REVOKE ALL ON FUNCTION tenants_con_muestras_por_tomar(timestamptz) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_muestras_por_tomar(timestamptz) TO iaxti_app;
  END IF;
END $$;
