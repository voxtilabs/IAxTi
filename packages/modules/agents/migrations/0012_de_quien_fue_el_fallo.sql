-- De quién fue el fallo (#684).
--
-- `agent_executions.error` es una columna de TEXTO, y la bandeja reconstruye un
-- Error desde ahí para explicar por qué no hubo sugerencia. La marca que
-- distingue «falló el proveedor» de «falló una herramienta nuestra» se pone en
-- memoria, en el puerto del modelo, y no sobrevive a la base: sin esta columna,
-- ese camino sigue clasificando por texto y sigue diciéndole al dueño que su
-- proveedor de IA se quedó sin saldo cuando lo que pasó fue un permiso denegado.
--
-- Aditiva y nullable a propósito. NULL es «no se sabe», que es la verdad de las
-- filas escritas antes de esta migración, y no saberlo impide afirmar: se lee
-- como «no consta que sea del proveedor», no como «sí».
ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS error_del_proveedor boolean;

COMMENT ON COLUMN agent_executions.error_del_proveedor IS
  'true: el error vino del proveedor de IA. false: fue nuestro (tool, permiso, cuota). NULL: no se sabe (filas anteriores a #684).';
