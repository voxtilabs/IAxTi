-- Preguntar UNA vez quién tiene plantillas en revisión (#743, ADR-0026).
--
-- `plantillas-sync` recorría TODOS los tenants vivos y abría una transacción por
-- cada uno solo para preguntar «¿tienes alguna plantilla pendiente?». La consulta
-- de adentro ya estaba bien pensada —si no hay nada esperando, no molesta al
-- proveedor— pero la TRANSACCIÓN se pagaba igual, por cada tenant, en cada
-- vuelta.
--
-- Medido el 09/10 con 1.283 tenants: 4,5 ms cada uno, ~5,8 s el barrido entero.
-- Proyectado a mil tenants con la base a 64 ms de distancia (#711): minutos.
--
-- Es el sexto barrido de esta familia —#580, #733 (dos), #738, #740— y por eso
-- este PR trae además la guarda: lo que cierra la clase no es arreglar el sexto.
--
-- Acotaciones de ADR-0026: sale una lista de ids y nada más, `search_path` fijo,
-- `EXECUTE` concedido explícitamente. Sin parámetro: el barrido no tiene reloj
-- inyectado ni plazos, la condición es un estado.
--
-- Vive acá y no en `apps/workers` porque la tabla es de `whatsapp`. Es la lección
-- de #738: CI cazó una migración de `analytics` que referenciaba `conversations`
-- —«relation does not exist»— porque el runner aplica en orden topológico de
-- dependencias. Y `apps/workers` no tiene migraciones propias: no es un módulo.

CREATE OR REPLACE FUNCTION tenants_con_plantillas_en_revision()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT p.tenant_id
    FROM whatsapp_templates p
    JOIN tenants t ON t.id = p.tenant_id
   WHERE p.status = 'pending'
     AND COALESCE(t.state, 'active') <> 'deleted';
$$;

REVOKE ALL ON FUNCTION tenants_con_plantillas_en_revision() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_plantillas_en_revision() TO iaxti_app;
  END IF;
END $$;
