-- Preguntar UNA vez quién tiene trabajo de facturación (#580, ADR-0026).
--
-- `sweepBilling` recorría TODOS los tenants vivos, uno por uno, abriendo una
-- transacción y corriendo los seis pasos del ciclo. Eso vino de #286 y fue
-- correcto: un barrido global —`SELECT ... FROM subscriptions` suelto al pool—
-- devuelve cero filas con el rol de producción, porque esas tablas tienen RLS y
-- una consulta fuera de `withTenant` corre sin `app.tenant_id`.
--
-- Medido el 09/10 en una base con 1.232 tenants: visitar uno SIN trabajo cuesta
-- 4,5 ms, así que el barrido entero son ~5,5 s. Proyectado a mil tenants con la
-- base a 64 ms de distancia (#711): **diez minutos de un cron haciendo nada**.
-- Preguntar una vez quién tiene trabajo: 2 ms.
--
-- Esta función es el segundo SECURITY DEFINER del sistema —el primero es
-- `resolver_api_key`, y su migración dice «es el único»; esa frase deja de ser
-- cierta y por eso hay ADR—. Se acota con el mismo criterio:
--
--   * Sale una lista de IDS DE TENANT y nada más. Ni montos, ni estados, ni
--     nombres. `tenants` no tiene RLS, así que esos ids ya son visibles para el
--     rol de la aplicación: lo único que agrega es CUÁLES tienen trabajo.
--   * NO acepta parámetros. No sirve para preguntar por un tenant ajeno ni para
--     recorrer nada.
--   * `SET search_path = public`: sin esto, quien controle el search_path puede
--     hacer que la función llame a otra cosa.
--   * El EXECUTE se concede explícitamente; no queda abierto a PUBLIC.
--
-- El barrido sigue entrando a cada tenant con `withTenant`: esta función decide
-- A QUIÉN visitar, y todo lo que se lee y se escribe sigue pasando por RLS. Si
-- devolviera un tenant de más, el paso correspondiente no encontraría trabajo y
-- no haría nada.
--
-- Los días de gracia y de suspensión son PARÁMETROS del código
-- (`DIAS_GRACIA_READONLY`, `DIAS_HASTA_SUSPENDER`), y acá se usan los umbrales
-- MÁS AMPLIOS a propósito: esta función es un filtro, no la regla. Decide quién
-- se mira; quien decide qué pasa es el barrido, con sus números. Duplicar los
-- plazos acá los pondría en dos lugares, y el día que cambien, uno quedaría
-- viejo y nadie se enteraría — un tenant dejaría de ser visitado y su
-- suspensión no llegaría nunca.

CREATE OR REPLACE FUNCTION tenants_con_trabajo_de_facturacion()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id
    FROM tenants t
   WHERE COALESCE(t.state, 'active') <> 'deleted'
     AND (
       -- 0. La prueba terminó.
       (t.state = 'trial' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < now())
       -- 1. Ciclo vencido: hay que emitir.
       OR EXISTS (
         SELECT 1 FROM subscriptions s
          WHERE s.tenant_id = t.id
            AND s.status <> 'cancelled'
            AND s.next_charge_at <= now()::date
       )
       -- 2 y 3. Facturas por cobrar o ya vencidas: el paso decide el plazo.
       OR EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.tenant_id = t.id
            AND i.status IN ('issued', 'overdue')
       )
       -- 4. En solo lectura: el paso decide si ya se cumplieron los días.
       OR t.state = 'read_only'
       -- 5. Cancelación con fecha cumplida.
       OR EXISTS (
         SELECT 1 FROM subscriptions s
          WHERE s.tenant_id = t.id
            AND s.status = 'cancelled'
            AND s.cancel_at IS NOT NULL
            AND s.cancel_at <= now()::date
       )
     )
   ORDER BY t.created_at;
$$;

REVOKE ALL ON FUNCTION tenants_con_trabajo_de_facturacion() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_trabajo_de_facturacion() TO iaxti_app;
  END IF;
END $$;
