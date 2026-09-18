-- Cuántos casos de un run dieron una nota LEGIBLE (#53).
--
-- Antes un caso que no se podía medir —el modelo cortó la respuesta, el juez
-- devolvió JSON a medias— entraba al promedio como un 0. El score guardado
-- quedaba hundido sin que nada lo dijera, y de ese score depende el gate que
-- decide si una versión del agente puede reemplazar a la vigente.
--
-- Aditiva: los runs viejos quedan con cases_medidos = case_count, que es lo
-- que esos runs asumían de todas formas.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS cases_medidos INT;
UPDATE eval_runs SET cases_medidos = case_count WHERE cases_medidos IS NULL;
