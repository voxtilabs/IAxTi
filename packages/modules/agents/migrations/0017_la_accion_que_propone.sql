-- La acción que el asistente PROPONE junto a su respuesta (#1000).
--
-- ## El hueco que cierra
--
-- El asistente puede contestar solo —`autoRespondForInbound` manda el mensaje
-- firmado, con su nombre y el «escribe humano»— pero no puede HACER. Las siete
-- herramientas que escriben están cerradas por ADR-0017 («sale hacia el cliente
-- o pisa trabajo de una persona»), así que cuando el cliente dice «agéndame el
-- jueves a las 4», el asistente puede VER los huecos y no puede agendar. La
-- conversación llega al punto de la acción y se detiene.
--
-- Esto no abre esas puertas: las convierte en una propuesta. El ADR decía que
-- esas acciones las decide una persona, y acá una persona las decide — en un
-- toque, desde la bandeja, con SUS permisos.
--
-- ## Por qué acá y no en una tabla nueva
--
-- `suggestions` ya es esto. Tiene el ciclo completo —`pending`, `sent`,
-- `dismissed`, `expired`—, vence a los quince minutos, y ya traía una acción
-- propuesta cableada a mano para un solo caso: `suggest_deal`, el booleano
-- «¿creo la oportunidad?». Esta columna es ese booleano hecho general.
--
-- Y tiene el 👍/👎 que alimenta el dataset de evaluación (#53), así que una
-- acción propuesta que el dueño descarta enseña igual que un texto descartado.
--
-- ## La forma
--
-- `{ "herramienta": "agenda.agendar", "argumentos": { … } }`, donde
-- `herramienta` es un nombre del catálogo del Agente General — el generado del
-- OpenAPI, no una lista a mano. Aplicarla llama a `aplicarPropuesta`, que es la
-- MISMA función que usa el Agente General: revalida el módulo, revalida el
-- permiso de la persona, y llama a la ruta. Un solo camino de ejecución, dos
-- puertas de entrada.
--
-- `jsonb` y no dos columnas: los argumentos son de forma distinta por
-- herramienta y validarlos es trabajo del esquema de la ruta, no del CHECK.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS accion jsonb;

-- Lo único que el CHECK puede afirmar sin volverse un segundo validador: que
-- si hay acción, trae el nombre de una herramienta. Lo demás —que exista, que
-- el módulo esté activo, que la persona tenga el permiso— se revalida AL
-- APLICAR y no al guardar, porque entre que el asistente propone y el dueño
-- aprieta pueden pasar quince minutos y cambiar las tres cosas.
ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_accion_con_herramienta;
ALTER TABLE suggestions ADD CONSTRAINT suggestions_accion_con_herramienta
  CHECK (accion IS NULL OR (accion ? 'herramienta' AND length(accion->>'herramienta') > 0));
