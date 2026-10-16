-- #64: autorización personal de archivos. Los adjuntos publicados al equipo
-- guardan solo referencias; no convierten el consentimiento IA en compartido.
CREATE TABLE drive_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  grant_id uuid NOT NULL REFERENCES google_oauth_grants(id),
  account_key text NOT NULL,
  file_id text NOT NULL,
  name text NOT NULL,
  mime_type text NOT NULL,
  web_url text NOT NULL,
  ai_allowed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,user_id,file_id),
  UNIQUE(id,tenant_id,user_id)
);
CREATE INDEX drive_files_tenant_idx ON drive_files(tenant_id,user_id,ai_allowed);
ALTER TABLE drive_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drive_files USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE drive_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  drive_file_id uuid NOT NULL,
  name text NOT NULL,
  mime_type text NOT NULL,
  web_url text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id),
  conversation_id uuid REFERENCES conversations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(drive_file_id,tenant_id,user_id) REFERENCES drive_files(id,tenant_id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX drive_attachments_context_idx ON drive_attachments(tenant_id,drive_file_id,contact_id,COALESCE(conversation_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX drive_attachments_tenant_idx ON drive_attachments(tenant_id,contact_id,conversation_id);
ALTER TABLE drive_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drive_attachments USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE drive_contact_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id),
  grant_id uuid NOT NULL REFERENCES google_oauth_grants(id),
  account_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  folder_id text,
  folder_ready boolean NOT NULL DEFAULT false,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,user_id,contact_id),
  UNIQUE(id,tenant_id,user_id)
);
CREATE INDEX drive_contact_folders_tenant_idx ON drive_contact_folders(tenant_id,contact_id) WHERE enabled;
ALTER TABLE drive_contact_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_contact_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drive_contact_folders USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE drive_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_key text NOT NULL,
  name text NOT NULL,
  mime_type text NOT NULL,
  google_file_id text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploaded','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(folder_id,tenant_id,user_id) REFERENCES drive_contact_folders(id,tenant_id,user_id) ON DELETE CASCADE,
  UNIQUE(tenant_id,user_id,message_id,attachment_key)
);
CREATE INDEX drive_uploads_tenant_idx ON drive_uploads(tenant_id,next_attempt_at) WHERE status='pending';
ALTER TABLE drive_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drive_uploads USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Proyección mínima para el worker, nunca barrido de todos los negocios.
CREATE FUNCTION tenants_con_adjuntos_drive()
RETURNS TABLE(tenant_id uuid) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT DISTINCT u.tenant_id FROM public.drive_uploads u
  JOIN public.tenants t ON t.id=u.tenant_id
  JOIN public.plan_limits p ON p.plan=t.plan
  WHERE u.status='pending' AND u.next_attempt_at<=now()
    AND t.state IN ('active','trial') AND p.modules ? 'integrations'
$$;
REVOKE ALL ON FUNCTION tenants_con_adjuntos_drive() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_adjuntos_drive() TO iaxti_app;
  END IF;
END $$;
