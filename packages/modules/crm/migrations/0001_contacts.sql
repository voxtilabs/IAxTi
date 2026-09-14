-- crm, primera parte (SPEC §10): Contact, Company, Tag, CustomField.
-- El teléfono E.164 identifica al contacto dentro del tenant (SPEC §8).

CREATE TABLE IF NOT EXISTS companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  rut        text,
  custom     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_tenant_idx ON companies (tenant_id);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'companies') THEN
    CREATE POLICY tenant_isolation ON companies
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  phone            text NOT NULL, -- E.164, normalizado en dominio
  name             text,
  email            text,
  rut              text, -- validado con DV en dominio; se guarda normalizado
  company_id       uuid REFERENCES companies(id),
  owner_id         uuid,
  origin           text NOT NULL DEFAULT 'manual'
                   CHECK (origin IN ('whatsapp','webchat','importado','manual')),
  channels         jsonb NOT NULL DEFAULT '[]'::jsonb,
  custom           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Consentimiento con evidencia (SPEC §8): opt-in registrado u opt-out.
  opt_in_at        timestamptz,
  opt_in_channel   text,
  opt_in_evidence  text,
  opted_out_at     timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_phone_idx ON contacts (tenant_id, phone);
CREATE INDEX IF NOT EXISTS contacts_tenant_owner_idx ON contacts (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS contacts_tenant_activity_idx ON contacts (tenant_id, last_activity_at DESC);
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contacts') THEN
    CREATE POLICY tenant_isolation ON contacts
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Etiquetas con COLOR DE ROL Pulso, jamás hex (SPEC §10/§29).
CREATE TABLE IF NOT EXISTS tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  role       text NOT NULL DEFAULT 'neutral'
             CHECK (role IN ('action','good','warn','bad','info','neutral')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tags') THEN
    CREATE POLICY tenant_isolation ON tags
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contact_tags (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  tag_id     uuid NOT NULL REFERENCES tags(id),
  PRIMARY KEY (contact_id, tag_id)
);
ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contact_tags') THEN
    CREATE POLICY tenant_isolation ON contact_tags
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Campos custom por entidad (SPEC §10), visibles o no para la IA.
CREATE TABLE IF NOT EXISTS custom_fields (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  entity     text NOT NULL CHECK (entity IN ('contact','company','deal')),
  key        text NOT NULL,
  label      text NOT NULL,
  type       text NOT NULL CHECK (type IN ('texto','numero','fecha','lista','si_no','moneda')),
  required   boolean NOT NULL DEFAULT false,
  visible_ia boolean NOT NULL DEFAULT true,
  options    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, key)
);
ALTER TABLE custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'custom_fields') THEN
    CREATE POLICY tenant_isolation ON custom_fields
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
