-- Asignación y SLA (#38, SPEC §11): marcas de una-sola-vez para el aviso de
-- "new sin dueño" y el incumplimiento de primera respuesta. Aditiva.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS unattended_alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_breached_at       timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_via          text
    CHECK (assigned_via IN ('manual','round_robin','last_owner','ia_horario'));

-- Los barridos del job programado (cada minuto, por tenant activo).
CREATE INDEX IF NOT EXISTS conversations_unattended_idx
  ON conversations (tenant_id, created_at)
  WHERE state = 'new' AND owner_id IS NULL AND unattended_alerted_at IS NULL;
CREATE INDEX IF NOT EXISTS conversations_sla_idx
  ON conversations (tenant_id, created_at)
  WHERE state IN ('new','open') AND first_response_at IS NULL AND sla_breached_at IS NULL;
