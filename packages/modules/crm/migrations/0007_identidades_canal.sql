-- #74: quien escribe por Instagram o Messenger NO trae teléfono ni correo, solo
-- un id de chat. La identidad del contacto pasa a ser POR CANAL; el teléfono
-- queda como lo que siempre fue, la identidad del canal WhatsApp (nullable
-- desde #46). Aditiva: ninguna fila existente se rompe y el backfill deja a los
-- contactos de hoy con su identidad de WhatsApp explícita.

-- El origen ahora puede ser cualquiera de los canales que atendemos.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_origin_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_origin_check
  CHECK (origin IN ('whatsapp','webchat','importado','manual','instagram','messenger'));

CREATE TABLE IF NOT EXISTS contact_identities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel    text NOT NULL
             CHECK (channel IN ('whatsapp','webchat','instagram','messenger','simulador')),
  -- Teléfono E.164, id de chat de Instagram/Messenger o BSUID de WhatsApp:
  -- opaco a propósito, se guarda tal cual llega.
  identity   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, identity)
);
CREATE INDEX IF NOT EXISTS contact_identities_contact_idx
  ON contact_identities (tenant_id, contact_id);
ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_identities') THEN
    CREATE POLICY tenant_isolation ON contact_identities
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Backfill: el teléfono de cada contacto ya existente ES su identidad de
-- WhatsApp. Sin esto, el primer mensaje de un contacto conocido crearía uno
-- nuevo.
INSERT INTO contact_identities (tenant_id, contact_id, channel, identity)
  SELECT tenant_id, id, 'whatsapp', phone
    FROM contacts
   WHERE phone IS NOT NULL AND merged_into IS NULL
ON CONFLICT DO NOTHING;
