-- notifications (#55, SPEC §21): campana + preferencias.
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL,
  type        text NOT NULL CHECK (type IN
              ('conversacion_sin_dueno','sla_vencido','mencion','tarea_vencida','cuota_ia','calidad_numero')),
  title       text NOT NULL,
  body        text,
  link        text, -- a dónde lleva el clic (/bandeja, /contactos/…)
  -- Agrupación anti-inundación: la ráfaga incrementa la misma fila no-leída.
  group_count int  NOT NULL DEFAULT 1,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON notifications (tenant_id, user_id, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'notifications') THEN
    CREATE POLICY tenant_isolation ON notifications
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Preferencias por usuario, tipo y canal. Sin fila = el default del tipo.
CREATE TABLE IF NOT EXISTS notification_preferences (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  type       text NOT NULL,
  campana    boolean NOT NULL DEFAULT true,
  correo     boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id, type)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'notification_preferences') THEN
    CREATE POLICY tenant_isolation ON notification_preferences
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
