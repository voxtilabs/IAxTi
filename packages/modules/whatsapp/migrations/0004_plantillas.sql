-- Plantillas de WhatsApp (#44, SPEC §12).
--
-- Fuera de la ventana de 24 h Meta solo deja salir una plantilla aprobada
-- por ellos. Sin esto, una conversación que se enfrió no se retoma nunca, y
-- el envío segmentado a la cartera (#75) no puede existir: sale fuera de
-- ventana por definición.
--
-- El estado lo manda Meta y puede cambiar SOLO: una plantilla aprobada se
-- pausa si la gente la reporta. Por eso `status` no es un campo de
-- formulario sino el reflejo de lo que dice el proveedor.
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name            text NOT NULL,
  language        text NOT NULL,
  category        text NOT NULL CHECK (category IN ('marketing','utility','authentication')),
  header          text,
  body            text NOT NULL,
  footer          text,
  buttons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','pending','approved','rejected','paused','disabled')),
  -- Lo que contestó el proveedor: el id con el que la conoce y, si la
  -- rechazó, por qué. Sin el motivo a la vista, corregirla es adivinar.
  provider_id     text,
  rejection_reason text,
  submitted_at    timestamptz,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Una plantilla es única por nombre e idioma: la misma en español y en
  -- inglés son dos, y Meta las trata así.
  UNIQUE (tenant_id, name, language)
);
CREATE INDEX IF NOT EXISTS whatsapp_templates_tenant_idx
  ON whatsapp_templates (tenant_id, status);

ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'whatsapp_templates') THEN
    CREATE POLICY tenant_isolation ON whatsapp_templates
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
