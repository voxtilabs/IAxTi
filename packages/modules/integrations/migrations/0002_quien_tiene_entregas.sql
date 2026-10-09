-- Preguntar UNA vez quién tiene entregas pendientes (#743, ADR-0026).
--
-- `deliverWebhooks` recorría TODOS los tenants vivos y abría una transacción por
-- cada uno para consultar sus entregas vencidas. No salía rojo en las pruebas
-- porque esa prueba ya tiene su presupuesto declarado (#728) — o sea que el
-- costo estaba ahí, tapado por el arreglo del síntoma.
--
-- Medido el 09/10 con 1.283 tenants: 4,5 ms cada uno, ~5,8 s el barrido entero.
-- Proyectado a mil tenants con la base a 64 ms de distancia (#711): minutos. Y
-- este barrido corre seguido: es el que entrega los webhooks del cliente.
--
-- Acotaciones de ADR-0026: sale una lista de ids y nada más, `search_path` fijo,
-- `EXECUTE` concedido explícitamente.
--
-- Acepta el instante como la de recordatorios (#733) y no como la de secuencias
-- (#740), porque acá SÍ hay un plazo —`next_retry_at`— y el día que el barrido
-- acepte un reloj para probarse, el filtro tiene que mirar el mismo o van a
-- discrepar. Es gratis dejarlo bien ahora.
--
-- Lo que la función NO hace es decidir la entrega: el tope de 100 por tenant, el
-- backoff y el apagado del endpoint tras 24 h de falla sostenida los sigue
-- decidiendo el barrido.
--
-- PERO sí filtra por estado, y eso NO es opcional. La llamada traía
-- `estados: ['trial','active','past_due','read_only']` con su motivo escrito:
-- «una cuenta suspendida no manda NADA hacia afuera, y los webhooks eran el único
-- camino de salida que no lo respetaba». Pasar `ids` cortocircuita esa lista —
-- `idsDeTenants` devuelve la lista tal cual cuando se la dan— así que si la
-- función no replicara el filtro, los suspendidos volverían a mandar webhooks sin
-- que nada lo diga. El estado va acá, y `read_only` SÍ sigue recibiendo: §6
-- restringe los mensajes que INICIA el negocio, no que sus integraciones se
-- mantengan al día.

CREATE OR REPLACE FUNCTION tenants_con_entregas_pendientes(p_ahora timestamptz DEFAULT now())
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT d.tenant_id
    FROM webhook_deliveries d
    JOIN tenants t ON t.id = d.tenant_id
   WHERE d.status = 'pending'
     AND d.next_retry_at <= p_ahora
     AND COALESCE(t.state, 'active') IN ('trial', 'active', 'past_due', 'read_only');
$$;

REVOKE ALL ON FUNCTION tenants_con_entregas_pendientes(timestamptz) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_entregas_pendientes(timestamptz) TO iaxti_app;
  END IF;
END $$;
