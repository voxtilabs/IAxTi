-- La bandeja como herramienta de equipo (#39, SPEC §11): quick replies con
-- variables, notas internas con menciones y búsqueda de texto completo.
-- Los ADJUNTOS van a R2 con prefijo por tenant (SPEC §36/§40): en Postgres
-- solo queda la metadata dentro de messages.attachments.

CREATE TABLE IF NOT EXISTS quick_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid, -- NULL = del negocio (exige quickreplies.manage); si no, personal
  shortcut   text NOT NULL, -- el atajo que se tipea: "gracias", "horario", …
  body       text NOT NULL, -- con variables {nombre}, {monto}, …
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_tenant_idx
  ON quick_replies (tenant_id, shortcut) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_user_idx
  ON quick_replies (tenant_id, user_id, shortcut) WHERE user_id IS NOT NULL;
ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE quick_replies FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'quick_replies') THEN
    CREATE POLICY tenant_isolation ON quick_replies
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Visible SOLO para el equipo: vive fuera de messages a propósito — jamás
-- se puede enviar por error a un canal.
CREATE TABLE IF NOT EXISTS internal_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  author_id       uuid NOT NULL,
  body            text NOT NULL,
  mentions        uuid[] NOT NULL DEFAULT '{}', -- usuarios mencionados con @
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS internal_notes_conversation_idx
  ON internal_notes (tenant_id, conversation_id, created_at);
ALTER TABLE internal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_notes FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'internal_notes') THEN
    CREATE POLICY tenant_isolation ON internal_notes
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Búsqueda de texto completo en español (mensajes + transcripciones + notas).
-- Columnas generadas: se indexan solas, sin triggers propios.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS search tsvector
    GENERATED ALWAYS AS (
      to_tsvector('spanish', coalesce(body, '') || ' ' || coalesce(transcription, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING gin (search);
ALTER TABLE internal_notes
  ADD COLUMN IF NOT EXISTS search tsvector
    GENERATED ALWAYS AS (to_tsvector('spanish', body)) STORED;
CREATE INDEX IF NOT EXISTS internal_notes_search_idx ON internal_notes USING gin (search);
