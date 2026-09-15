-- El medidor de conversaciones activas del ciclo (SPEC §9, tabla de planes:
-- "Conversaciones activas / mes: tope del plan").
--
-- El medidor existía —`UsageMeter` con la métrica `conversations`— y el
-- panel del SuperAdmin lo muestra en la ficha de cada tenant. Nadie lo
-- incrementaba nunca, así que ese número era siempre 0: la pantalla que se
-- usa para ver cómo le va a un cliente mentía sobre su métrica principal.
--
-- La marca vive en la conversación y no en una tabla aparte para que contar
-- sea una sola escritura atómica: si el UPDATE cambia la fila, es la primera
-- vez del ciclo y recién ahí se suma.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS usage_period text;

COMMENT ON COLUMN conversations.usage_period IS
  'Ciclo (AAAA-MM) en que esta conversación ya se contó como activa.';
