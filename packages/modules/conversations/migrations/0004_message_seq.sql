-- Orden ESTABLE de mensajes (#46): now() es fijo por transacción, así que
-- dos mensajes de la misma transacción (el volcado del webchat) empatan en
-- created_at. El seq desempata de una vez y para siempre.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq bigserial;
CREATE INDEX IF NOT EXISTS messages_conversation_seq_idx
  ON messages (tenant_id, conversation_id, seq);
