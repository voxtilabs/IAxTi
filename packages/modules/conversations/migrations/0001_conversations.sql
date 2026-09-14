-- conversations, primera parte (SPEC §11): Conversation, Message, Assignment.
-- last_message_at y last_inbound_at se mantienen por trigger desde el día uno
-- (SPEC §39): cierre automático, archivo y ventana de 24 h dependen de ellos.

CREATE TABLE IF NOT EXISTS conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  contact_id         uuid NOT NULL REFERENCES contacts(id),
  channel            text NOT NULL DEFAULT 'whatsapp'
                     CHECK (channel IN ('whatsapp','webchat','simulador')),
  channel_account_id uuid, -- cuenta de canal; FK cuando exista channels (Fase 3)
  state              text NOT NULL DEFAULT 'new'
                     CHECK (state IN ('new','open','pending','resolved','snoozed')),
  owner_id           uuid,
  team_id            uuid,
  priority           text NOT NULL DEFAULT 'normal'
                     CHECK (priority IN ('baja','normal','alta','urgente')),
  deal_id            uuid REFERENCES deals(id), -- oportunidad vinculada
  last_inbound_at    timestamptz,               -- ventana de 24 h (SPEC §11)
  last_message_at    timestamptz,               -- cualquier dirección (SPEC §39)
  first_response_at  timestamptz,
  snoozed_until      timestamptz,
  archived_at        timestamptz,               -- bandera sobre resolved, no un estado
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Índices de la sección 39, tal cual.
CREATE INDEX IF NOT EXISTS conversations_tenant_state_last_idx
  ON conversations (tenant_id, state, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_tenant_archived_idx
  ON conversations (tenant_id, archived_at);
CREATE INDEX IF NOT EXISTS conversations_tenant_contact_idx
  ON conversations (tenant_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_tenant_owner_idx
  ON conversations (tenant_id, owner_id) WHERE state IN ('new','open','pending');
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'conversations') THEN
    CREATE POLICY tenant_isolation ON conversations
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  conversation_id     uuid NOT NULL REFERENCES conversations(id),
  direction           text NOT NULL CHECK (direction IN ('in','out')),
  type                text NOT NULL DEFAULT 'texto'
                      CHECK (type IN ('texto','imagen','audio','documento',
                                      'ubicacion','contacto','plantilla','interactivo')),
  body                text,
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Estado de entrega: solo los salientes lo llevan (SPEC §11).
  delivery_status     text CHECK (delivery_status IN ('queued','sent','delivered','read','failed')),
  author_kind         text NOT NULL CHECK (author_kind IN ('contact','user','agent','system')),
  author_id           uuid,
  provider_message_id text,     -- id de Meta/canal; da idempotencia a los webhooks
  transcription       text,     -- audio transcrito, buscable (agents, Fase 3)
  meta                jsonb NOT NULL DEFAULT '{}'::jsonb, -- costo Meta, error de envío, …
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (direction = 'out' OR delivery_status IS NULL)
);
CREATE INDEX IF NOT EXISTS messages_tenant_conversation_idx
  ON messages (tenant_id, conversation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_id_idx
  ON messages (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'messages') THEN
    CREATE POLICY tenant_isolation ON messages
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Historial de dueños con motivo (SPEC §11).
CREATE TABLE IF NOT EXISTS assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  from_owner_id   uuid,
  to_owner_id     uuid,
  reason          text,
  actor           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignments_conversation_idx
  ON assignments (tenant_id, conversation_id, created_at);
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'assignments') THEN
    CREATE POLICY tenant_isolation ON assignments
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Trigger SPEC §39: cada mensaje toca last_message_at; los entrantes además
-- last_inbound_at (ventana de 24 h). Corre con el rol que inserta, dentro de
-- la misma transacción y bajo la misma RLS del tenant.
CREATE OR REPLACE FUNCTION conversations_touch_from_message() RETURNS trigger AS $$
BEGIN
  UPDATE conversations SET
    last_message_at = NEW.created_at,
    last_inbound_at = CASE WHEN NEW.direction = 'in' THEN NEW.created_at ELSE last_inbound_at END,
    updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS messages_touch_conversation ON messages;
CREATE TRIGGER messages_touch_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION conversations_touch_from_message();
