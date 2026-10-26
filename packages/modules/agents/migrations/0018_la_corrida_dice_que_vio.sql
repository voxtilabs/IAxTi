-- De una respuesta autónoma no se podía reconstruir QUÉ vio el modelo (#1079).
--
-- `agent_executions.input` guardaba solo `{ prompt }`, y ese prompt es el
-- FORMATO: las reglas no negociables, el JSON de salida, la lista de acciones.
-- Es el mismo texto en cada corrida. Lo que cambia —y lo único que explica la
-- respuesta— es el contexto: qué día es, quién es el cliente, el resumen de lo
-- anterior, el trozo de conocimiento recuperado y los últimos mensajes. Eso no
-- se guardaba en ninguna parte.
--
-- El propio código ya tenía escrito el motivo, al justificar `sources_used`:
-- «en modo autónomo nadie revisa antes de que salga, así que la única forma de
-- reconstruir después de dónde salió lo que se le dijo al cliente es que la
-- corrida lo tenga escrito». Se aplicó a medias: el id y el nombre de la
-- fuente sí, el trozo que se le entregó no — y el conocimiento se recupera por
-- RAG, así que el nombre de la fuente no dice qué leyó el modelo.
--
-- ## Por qué la columna va ANTES de guardar el contexto
--
-- Guardar el contexto significa copiar los últimos mensajes y el nombre y
-- teléfono del cliente a esta tabla. La purga de retención (SPEC §39) borra
-- por conversación —`internal_notes`, `assignments`, `suggestions`,
-- `agent_conversation_modes`, `sequence_enrollments`, `response_samples`,
-- `messages`— y `agent_executions` no estaba en esa lista porque NO PODÍA
-- estarlo: no tenía por dónde. Sin esta columna, el negocio acortaba su
-- retención, se le borraba el historial, y las corridas se quedaban con una
-- copia para siempre. Eso convierte un hueco de auditoría en un
-- incumplimiento, que es peor que el problema.
--
-- Nullable a propósito: las corridas de `configuracion_conversada` —el Agente
-- General configurando el negocio— no pertenecen a ninguna conversación, y
-- forzarlas a inventar una sería mentir sobre su origen. Esas no llevan texto
-- del cliente y no son lo que la purga tiene que alcanzar.
--
-- Sin FK a `conversations`: la purga borra la conversación en su propia
-- transacción y por lotes, y una FK obligaría a ordenar los dos borrados o a
-- un ON DELETE que haría el trabajo a espaldas de la purga —que es justo lo
-- que tiene que quedar explícito en su lista de tablas—. El aislamiento lo da
-- `tenant_id` y su política, como en el resto de la tabla.
ALTER TABLE agent_executions ADD COLUMN IF NOT EXISTS conversation_id uuid;

-- Empieza por `tenant_id` como pide la regla de base de datos, y sirve a la
-- consulta que de verdad se hace: «las corridas de ESTA conversación», tanto
-- para la purga como para mirar qué contestó el agente en un caso.
CREATE INDEX IF NOT EXISTS agent_executions_tenant_conversation_idx
  ON agent_executions (tenant_id, conversation_id)
  WHERE conversation_id IS NOT NULL;
