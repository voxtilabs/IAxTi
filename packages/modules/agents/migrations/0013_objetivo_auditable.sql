-- Objetivo medido a medias (#701).
--
-- `achieved_event` y `closed_at` se escribían y ningún `SELECT` las devolvía.
-- `tasaDeObjetivo` es la métrica con la que se defiende el producto frente al
-- cliente que paga, y estas dos columnas son las que la hacen auditable: qué
-- evento contó como logro, y cuándo se cerró el intento.
--
-- Y había un hueco peor: `closed_at` se estampaba SOLO al perder. Un intento
-- logrado quedaba con `closed_at` en NULL para siempre, así que «cuánto tarda
-- en lograrse» no se podía calcular y un intento logrado se veía, por esa
-- columna, igual que uno todavía abierto.
UPDATE agent_goal_attempts
   SET closed_at = achieved_at
 WHERE outcome = 'logrado' AND closed_at IS NULL AND achieved_at IS NOT NULL;

-- El casi-logro: un evento de éxito de este contacto que llegó FUERA de la
-- ventana de atribución.
--
-- Sin esto, «no contó» y «no pasó» se ven idénticos. Y es la pregunta que hace
-- el dueño cuando mira un intento perdido de un cliente que terminó comprando:
-- la respuesta honesta no es «se perdió», es «se perdió, y la venta llegó cinco
-- días después, fuera de los tres que atribuimos».
--
-- No cambia ninguna tasa a propósito: la ventana es una decisión y esto es
-- poder verla, no moverla.
ALTER TABLE agent_goal_attempts
  ADD COLUMN IF NOT EXISTS fuera_de_ventana_at timestamptz;
ALTER TABLE agent_goal_attempts
  ADD COLUMN IF NOT EXISTS fuera_de_ventana_event text;

-- Listar los logrados con su evento, sin recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS agent_goal_attempts_logrados_idx
  ON agent_goal_attempts (tenant_id, agent_id, closed_at DESC)
  WHERE outcome = 'logrado';
