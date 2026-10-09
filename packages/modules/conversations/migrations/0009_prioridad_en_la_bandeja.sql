-- La prioridad se usa (#550).
--
-- `conversations.priority` existe desde `0001` con su CHECK completo, está en
-- el SPEC, está en el tipo `Conversation` y **la API la devuelve en cada
-- conversación de la bandeja**. Cero escrituras, cero pantallas, cero filtros,
-- cero ordenamientos: siempre `'normal'`.
--
-- Y era peor que si no existiera: el campo sí viaja en la respuesta, así que
-- quien consuma la API —el SDK, una integración— dibuja un selector o una
-- insignia de prioridad que el backend nunca iba a poder cambiar.
--
-- La columna no cambia. Lo que falta es el índice: con la prioridad en el
-- `ORDER BY` antes de la fecha, el índice `(tenant_id, state, last_message_at)`
-- deja de servir para ordenar y Postgres pasa a ordenar en memoria. Con
-- doscientas conversaciones no se nota; el día de una promoción, sí — y ése es
-- exactamente el día en que la prioridad importa.
--
-- `priority DESC` no sirve: el orden del texto es alfabético ('alta' < 'baja' <
-- 'normal' < 'urgente'), que no tiene nada que ver con la urgencia. El rango va
-- en una expresión, y el índice la indexa tal cual para que coincida con el
-- `ORDER BY` de la consulta.
CREATE INDEX IF NOT EXISTS conversations_prioridad_idx
  ON conversations (
    tenant_id,
    (CASE priority
       WHEN 'urgente' THEN 3
       WHEN 'alta'    THEN 2
       WHEN 'normal'  THEN 1
       ELSE 0
     END) DESC,
    last_message_at DESC,
    id DESC
  )
  WHERE archived_at IS NULL;
