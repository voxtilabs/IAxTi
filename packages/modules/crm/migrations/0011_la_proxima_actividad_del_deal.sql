-- La próxima actividad pendiente de una oportunidad (#1302).
--
-- El tablero necesita, por tarjeta, cuál es lo próximo que hay que hacer. El
-- dato ya estaba en `activities` desde la migración 0003 —`deal_id`, `due_at`,
-- `done_at`— y no lo leía nadie.
--
-- El índice que había, `activities_due_idx (tenant_id, due_at)`, sirve para
-- barrer los vencimientos de todo el negocio, que es otra pregunta. Para esta
-- —«de ESTA oportunidad, la pendiente más próxima»— el orden de las columnas
-- está al revés y obliga a filtrar por `deal_id` después de leer.
--
-- Parcial por `done_at IS NULL`: lo completado no se consulta nunca por esta
-- vía y es la mayoría de las filas con el tiempo. El índice se queda chico.
CREATE INDEX IF NOT EXISTS activities_proxima_del_deal_idx
  ON activities (tenant_id, deal_id, due_at)
  WHERE done_at IS NULL;
