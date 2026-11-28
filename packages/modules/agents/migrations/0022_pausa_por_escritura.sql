-- La regla de #1416: escribir de humano apaga la IA, con duración elegida.
--
-- `vuelve_el` es el único dato nuevo: la pausa «hasta volver» es
-- `vuelve_el IS NULL` sobre un modo `assist` ya existente, y el barrido
-- restaura cuando vence. Aditiva: sin ella, todo sigue funcionando igual —
-- el `UPDATE` de la pausa solo corre desde la app que ya trae esta versión.
ALTER TABLE agent_conversation_modes ADD COLUMN IF NOT EXISTS vuelve_el timestamptz;
