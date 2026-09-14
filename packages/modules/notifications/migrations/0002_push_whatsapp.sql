-- Notificaciones v2 (#78): el dueño de una pyme no vive en la app. Se suman
-- dos canales al aviso: push (navegador y celular) y WhatsApp al propio
-- equipo, desde el número del negocio.

-- Push nace ENCENDIDO porque no cuesta nada y solo llega si el usuario ya
-- dio permiso al navegador; WhatsApp nace APAGADO porque es intrusivo y
-- porque le cuesta plata al negocio: es opt-in explícito.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS push     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS whatsapp boolean NOT NULL DEFAULT false;

-- Una suscripción por navegador/dispositivo. El endpoint es la identidad
-- que da el servicio de push, y es único en el mundo.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  -- Cuándo dejó de existir del otro lado: se borra sola al confirmarlo.
  failed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON push_subscriptions (tenant_id, user_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'push_subscriptions') THEN
    CREATE POLICY tenant_isolation ON push_subscriptions
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
