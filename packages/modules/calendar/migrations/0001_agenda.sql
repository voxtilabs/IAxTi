-- La agenda (SPEC §16): agendar desde el chat con horarios reales.
--
-- La disponibilidad es CONFIGURADA por el negocio; el calendario real de
-- Google se cruza encima cuando esa conexión exista (#57). Separarlas así
-- permite que la agenda funcione sin Google — que es como va a empezar
-- cualquier pyme que pruebe el producto.
CREATE TABLE IF NOT EXISTS availability (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- De quién es esta disponibilidad: una persona del equipo. El equipo
  -- completo se resuelve sumando las de sus integrantes.
  owner_id       uuid NOT NULL,
  -- 0 = domingo, como `extract(dow)` de Postgres: se compara directo.
  weekday        int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- Hora local del NEGOCIO, no del servidor (#182).
  start_minute   int  NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute     int  NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  slot_minutes   int  NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 480),
  -- Respiro entre citas: sin esto se agenda pegado y nadie alcanza.
  buffer_minutes int  NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  -- Cuánto antes, como mínimo, se puede agendar. Una hora para dentro de
  -- diez minutos no le sirve a nadie.
  min_notice_minutes int NOT NULL DEFAULT 60 CHECK (min_notice_minutes >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);
CREATE INDEX IF NOT EXISTS availability_tenant_idx ON availability (tenant_id, owner_id, weekday);
ALTER TABLE availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'availability') THEN
    CREATE POLICY tenant_isolation ON availability
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS appointments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL,
  owner_id      uuid NOT NULL,
  conversation_id uuid,
  deal_id       uuid,
  title         text,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','confirmed','reminded','attended','no_show','cancelled','rescheduled')),
  -- Qué recordatorios ya salieron, para no mandar el de 24 h dos veces.
  reminders_sent jsonb NOT NULL DEFAULT '[]'::jsonb,
  google_event_id text,
  cancel_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS appointments_agenda_idx
  ON appointments (tenant_id, owner_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_recordatorio_idx
  ON appointments (tenant_id, status, starts_at)
  WHERE status IN ('confirmed','reminded');
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'appointments') THEN
    CREATE POLICY tenant_isolation ON appointments
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
