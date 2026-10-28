-- #56: intents antes de cada escritura externa; nunca tokens ni enlaces en SQL.
CREATE TABLE whatsapp_partner_invitations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 project_id text NOT NULL, credential_ref text NOT NULL,
 request_hash text NOT NULL, actor text NOT NULL, actor_kind text NOT NULL,
 phase text NOT NULL CHECK (phase IN ('creating','ambiguous','pending','connecting','provisioning','recovery_required','active','expired','cancelled','failed')),
 invitation_id text, provider_status text, sender_id text, account_id uuid,
 url_ref text, url_generation uuid NOT NULL DEFAULT gen_random_uuid(), provision_id text, expires_at timestamptz, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id), UNIQUE(project_id,invitation_id), UNIQUE(tenant_id,request_hash),
 FOREIGN KEY(account_id,tenant_id) REFERENCES channel_accounts(id,tenant_id)
);
CREATE UNIQUE INDEX whatsapp_partner_one_open ON whatsapp_partner_invitations(tenant_id)
 WHERE phase NOT IN ('expired','cancelled','failed','active');
CREATE INDEX whatsapp_partner_tenant_idx ON whatsapp_partner_invitations(tenant_id,created_at);
CREATE TABLE whatsapp_partner_events (
 tenant_id uuid NOT NULL, invitation_id uuid NOT NULL, event_id text NOT NULL,
 processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,event_id), FOREIGN KEY(invitation_id,tenant_id) REFERENCES whatsapp_partner_invitations(id,tenant_id)
);
CREATE INDEX whatsapp_partner_events_pending ON whatsapp_partner_events(tenant_id,invitation_id) WHERE processed_at IS NULL;
CREATE TABLE whatsapp_partner_secrets (
 tenant_id uuid NOT NULL, invitation_id uuid NOT NULL, secret_id text PRIMARY KEY,
 purpose text NOT NULL CHECK(purpose IN ('url','webhook')), version_ref text,
 destroy_pending boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(invitation_id,tenant_id) REFERENCES whatsapp_partner_invitations(id,tenant_id)
);
CREATE INDEX whatsapp_partner_secrets_tenant ON whatsapp_partner_secrets(tenant_id,created_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['whatsapp_partner_invitations','whatsapp_partner_events','whatsapp_partner_secrets'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO iaxti_app',t);
  END IF;
 END LOOP;
END $$;
-- Oráculos mínimos para callback autenticado y recuperación; no exponen PII/refs.
CREATE FUNCTION whatsapp_partner_tenant(p_project text,p_invitation text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT tenant_id FROM public.whatsapp_partner_invitations WHERE project_id=p_project AND invitation_id=p_invitation
$$;
CREATE FUNCTION whatsapp_partner_pending_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT tenant_id FROM public.whatsapp_partner_events WHERE processed_at IS NULL
 UNION SELECT tenant_id FROM public.whatsapp_partner_secrets WHERE destroy_pending
 UNION SELECT tenant_id FROM public.whatsapp_partner_invitations WHERE phase='pending' AND provider_status='pending' AND expires_at<=now()
 UNION SELECT tenant_id FROM public.whatsapp_partner_invitations WHERE phase IN ('creating','provisioning') AND updated_at<now()-interval '2 minutes'
$$;
REVOKE ALL ON FUNCTION whatsapp_partner_tenant(text,text),whatsapp_partner_pending_tenants() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
 GRANT EXECUTE ON FUNCTION whatsapp_partner_tenant(text,text),whatsapp_partner_pending_tenants() TO iaxti_app;
END IF; END $$;
