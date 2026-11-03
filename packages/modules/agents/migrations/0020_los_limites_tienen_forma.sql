-- Los límites del asistente tienen forma (#1232).
--
-- `agents.limits` nació con el comentario `-- max_executions_day, …` y esa
-- llave NUNCA existió: el único lector es `guardrailLimits`, que lee otras
-- cinco. O sea que lo que el esquema sugería escribir era, literalmente, una
-- llave que se guarda y no hace nada.
--
-- Un comentario equivocado en la columna es peor que ninguno: quien lo lee
-- escribe esa llave, el PUT responde 200 y el producto la ignora. Desde este
-- issue el cuerpo de `PUT /v1/agents/:id` se valida con un esquema que RECHAZA
-- la llave que ningún lector mira, así que acá queda escrito dónde vive la
-- lista de verdad — no una copia que se vuelva a desincronizar.
--
-- Nada de estructura cambia: es solo el comentario del catálogo de Postgres.
COMMENT ON COLUMN agents.limits IS
  'Guardarrieles del asistente. La forma la define el esquema LimitesDelAsistente '
  '(apps/api/src/agents.controller.ts) y la leen guardrailLimits (application/autonomous.ts) '
  'y configDelPulso (application/pulso.ts). Una llave que no esté en ese esquema se rechaza: '
  'antes se guardaba sin hacer nada (#1232).';

COMMENT ON COLUMN agents.autonomous_hours IS
  'Horario en que la IA puede contestar sola: start y end en HH:MM y days de 0 (domingo) a 6. '
  'Vacío = nunca sola, que es como nace (SPEC §13). Lo lee inAutonomousHours '
  '(application/autonomous.ts), y sin start o sin end devuelve false (#1232).';
