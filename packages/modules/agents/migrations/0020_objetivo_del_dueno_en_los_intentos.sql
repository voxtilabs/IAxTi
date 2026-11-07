-- Los objetivos del dueño también se miden (#1278).
--
-- Las migraciones 0010 y 0011 agregaron 'estadisticas' y 'configuracion' al
-- CHECK de `agents.objetivo`, y las dos explican en su propio comentario el
-- defecto que estaban arreglando: «la lista de objetivos vive en dos lugares
-- y agregar uno solo arriba lo deja pasar la validación para morir en la base
-- con un error de constraint». Las dos arreglaron UN lugar.
--
-- `agent_goal_attempts.objetivo` nació en la 0009 con su propio CHECK y los
-- cinco objetivos originales. Nadie lo tocó. Hoy lo único que impide que ese
-- INSERT reviente es `atiendeClientes()`, el filtro que la #410 puso para que
-- el asistente del dueño no le conteste a un cliente por WhatsApp: una
-- defensa que existe por otro motivo y que mañana se mueve.
--
-- Y el daño no sería un error aislado. `abrirIntento` corre dentro de la
-- transacción de la conversación: una violación de CHECK aborta la
-- transacción completa, y con ella la respuesta del agente.
ALTER TABLE agent_goal_attempts DROP CONSTRAINT IF EXISTS agent_goal_attempts_objetivo_check;
ALTER TABLE agent_goal_attempts ADD CONSTRAINT agent_goal_attempts_objetivo_check
  CHECK (objetivo IN ('agendar','vender','informar','calificar','cobrar',
                      'estadisticas','configuracion'));
