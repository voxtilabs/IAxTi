-- crm (#46): el visitante del webchat puede venir SIN teléfono (correo
-- basta). El modelo sigue WhatsApp-first: el índice único por teléfono ya
-- tolera NULL, y el correo identifica solo a los contactos sin teléfono.
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_email_idx
  ON contacts (tenant_id, email) WHERE phone IS NULL AND email IS NOT NULL;
