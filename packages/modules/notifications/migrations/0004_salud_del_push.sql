-- Avisos que se estampan y no avisan (#698).
--
-- `last_ok_at` y `failed_at` se escribían en cada envío y ninguna consulta las
-- devolvía: una suscripción que falla desde hace semanas seguía en la tabla y el
-- producto creía que estaba avisando. El dueño no recibía nada y nadie se
-- enteraba — ni él, ni nosotros.
--
-- Hace falta un CONTADOR y no solo la última fecha: un error aislado (la red del
-- celular, el servicio del navegador con un mal minuto) no es un dispositivo
-- roto, y tratar los dos igual llenaría la pantalla de avisos falsos. Lo que
-- importa es fallar N veces SEGUIDAS, así que el éxito lo vuelve a cero.
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0;

-- Nada se borra: se archiva (SPEC §39). Antes, un 404/410 del servicio borraba
-- la fila, y con ella el rastro de que ese dispositivo recibía avisos.
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS archived_reason text;

-- El diagnóstico cuenta las que están fallando sin recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS push_subscriptions_fallando_idx
  ON push_subscriptions (tenant_id, failed_count)
  WHERE archived_at IS NULL AND failed_count > 0;
