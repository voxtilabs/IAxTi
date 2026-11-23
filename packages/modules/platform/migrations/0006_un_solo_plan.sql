-- Un solo plan con todo (#1377, ADR-0036).
--
-- Decisión del dueño, 23-11: «quiero eliminar por ahora lo de los planes:
-- simplemente que IAxTi tenga estas cosas, que trae y ya». Así que todos los
-- negocios quedan en UN plan que trae los nueve módulos vendibles.
--
-- Aditiva a propósito. Los planes viejos (`base`, `crece`, `equipo`) NO se
-- borran: el rollback es solo de imagen (la versión anterior de la app tiene
-- que seguir funcionando con este esquema), y el día que vuelvan a venderse
-- planes, volver es cambiar `tenants.plan` de nuevo. El mecanismo —el guard
-- de `solo_lectura`, `modulosDelPlan`— se queda; simplemente nadie queda
-- fuera de nada.
--
-- Los topes NO desaparecen: dejan de ser comerciales y quedan como freno de
-- seguridad, para que un negocio (o un defecto) no deje una cuenta sin techo
-- con el proveedor de IA o con Meta. Son los del plan más alto que había.
INSERT INTO plan_limits (
  plan, whatsapp_numbers, conversations_month, ia_executions_month,
  retention_months, api_requests_month, modules, price_clp, meta_included_usd
) VALUES (
  'iaxti', 5, 8000, 12000, NULL, 200000,
  '["crm","conversations","agents","calendar","payments","automations","knowledge","integrations","analytics"]',
  99990, 60
)
ON CONFLICT (plan) DO UPDATE SET
  -- Si alguien re-corre la migración con la fila ya puesta, los MÓDULOS se
  -- aseguran (es la promesa de este cambio); los topes no se pisan, por si
  -- desde el panel de plataforma ya se ajustaron.
  modules = EXCLUDED.modules;

-- Todos adentro. Va con el nombre del plan y no con un `WHERE plan IN (...)`
-- para que un plan creado a mano en el panel tampoco quede afuera.
UPDATE tenants SET plan = 'iaxti' WHERE plan <> 'iaxti';

-- Y el que nace, nace acá. `createTenant` lo escribe explícito (organizations);
-- el DEFAULT de la columna es la red para cualquier otro INSERT.
ALTER TABLE tenants ALTER COLUMN plan SET DEFAULT 'iaxti';
