-- Una campaña deja de ser un `for` dentro de un request (#609, #610).
--
-- Antes: `POST /campanas/:id/enviar` recorría el segmento completo dentro de
-- una sola transacción HTTP y marcaba `done` al final. Tres consecuencias, las
-- tres medidas:
--
--  1. 900 contactos en un request es un timeout esperando ocurrir, y el tope
--     diario del canal corta a mitad de camino: el resto queda `failed` y la
--     campaña se reporta como ENVIADA.
--  2. No hay ningún punto donde consultar si alguien pidió parar, así que
--     `cancelled` existía en este CHECK y nada lo escribía nunca.
--  3. `contactosDelSegmento` tiene un tope de 5.000 y NADA lo decía: una
--     cartera de 7.000 recibía 5.000 mensajes y la campaña decía `done`, sin
--     saltados, sin motivo y sin fila para los 2.000 que faltaban.
--
-- El recorrido se va a un job por lotes. Lo que esta migración agrega es lo que
-- ese job necesita para ser honesto.

-- Cuántos eran al momento de lanzar. CONGELADO, como los filtros: el segmento
-- puede cambiar mientras la campaña sale, y «250 de 900» tiene que seguir
-- diciendo 900 o el informe se mueve solo.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS planned_total int;

-- Quién pidió parar y cuándo. Es una SOLICITUD, no el estado: el lote que está
-- saliendo termina —no se puede desencolar lo ya mandado al proveedor— y recién
-- ahí la campaña pasa a `cancelled`. Separar la solicitud del estado es lo que
-- permite que el aviso al dueño diga la verdad sobre los últimos.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS stopped_by uuid;

-- Por qué se detuvo, cuando no fue una persona: el tope del canal, el tope de
-- 5.000 del segmento. Va en texto y se le muestra al dueño.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS stop_reason text;

-- El estado nuevo: `partial`.
--
-- Es el que faltaba para que el criterio de aceptación de #609 —«una campaña
-- nunca se reporta como enviada si no salió completa»— se pueda cumplir. `done`
-- pasa a significar «salieron todos los que correspondía»; `partial` es
-- «quedaron N, y acá está el botón».
--
-- Se reemplaza el CHECK, y eso es compatible hacia atrás: la versión anterior
-- de la app solo escribe los cuatro valores viejos, que siguen siendo válidos.
-- Lo que no puede es LEER `partial` y entenderlo, y por eso la ventana de
-- compatibilidad de .claude/rules/db.md se respeta al revés de lo habitual: la
-- migración entra antes, el estado nuevo lo escribe recién la versión que sabe
-- mostrarlo.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('draft','sending','partial','done','cancelled'));

-- El lote pregunta «del segmento, quiénes todavía NO tienen fila acá». El
-- UNIQUE (campaign_id, contact_id) ya sirve para eso, pero el anti-join se
-- apoya en el prefijo (tenant_id, campaign_id) del índice de estados, que ya
-- existe. No hace falta índice nuevo: queda dicho para que nadie lo agregue
-- «por si acaso».
--
-- Y por qué el cursor es esta tabla y no una columna `last_contact_id`:
-- `ORDER BY created_at` no es un orden único —dos contactos del mismo instante
-- empatan— así que un cursor sobre la fecha saltaría o repetiría filas justo en
-- el empate. La tabla de destinatarios no puede desincronizarse de la realidad
-- porque ES la realidad, y hace que retomar sea idempotente de arranque.

-- ¿Qué negocios tienen una campaña que dice «saliendo» y no avanza?
--
-- El job que manda los lotes se encola al lanzar, y entre el `COMMIT` y el
-- `add()` hay otro sistema: Redis. `iniciarCampana` ya revierte a borrador si
-- encolar falla en el mismo request, pero eso no cubre lo demás —el job que se
-- pierde, el worker que estuvo caído mientras se lanzaba, el módulo apagado que
-- se vuelve a prender— y el resultado es siempre el mismo: una campaña
-- `sending` que nadie está mandando, con el dueño mirando un progreso que no se
-- mueve. Es el mismo modo de falla que #44 con las plantillas colgadas, y la
-- respuesta es la misma: el barrido PREGUNTA en vez de esperar.
--
-- Por qué una función SECURITY DEFINER y no un SELECT suelto: `campaigns` tiene
-- RLS, y una consulta cross-tenant con el rol de la aplicación devuelve CERO
-- filas (#286) — el barrido se vería funcionando y no haría nada nunca. Devuelve
-- solo ids, que es el patrón de ADR-0026.
CREATE OR REPLACE FUNCTION tenants_con_campanas_sin_avance(p_minutos int DEFAULT 10)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT c.tenant_id
    FROM campaigns c
    JOIN tenants t ON t.id = c.tenant_id
   WHERE c.status = 'sending'
     AND COALESCE(t.state, 'active') <> 'deleted'
     -- Sin avance: ni el arranque ni el último destinatario anotado son
     -- recientes. `started_at` solo no alcanza —una campaña larga lleva horas
     -- saliendo y está perfectamente viva— y el último destinatario solo
     -- tampoco, porque una campaña que nunca encoló a nadie no tiene ninguno.
     AND GREATEST(
           c.started_at,
           COALESCE(
             (SELECT max(r.created_at) FROM campaign_recipients r
               WHERE r.tenant_id = c.tenant_id AND r.campaign_id = c.id),
             c.started_at
           )
         ) < now() - make_interval(mins => p_minutos);
$$;

REVOKE ALL ON FUNCTION tenants_con_campanas_sin_avance(int) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_campanas_sin_avance(int) TO iaxti_app;
  END IF;
END $$;
