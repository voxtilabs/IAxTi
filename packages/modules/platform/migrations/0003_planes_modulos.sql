-- Planes y módulos sin desplegar (#69, SPEC §22): los planes son
-- CONFIGURACIÓN; los flags de módulos viven acá y el registry los toma
-- en caliente. Las acciones globales quedan en platform_audit (el
-- audit_log por tenant no aplica a lo cross-tenant).
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS price_clp numeric(14,0);
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS meta_included_usd numeric(10,2);
UPDATE plan_limits SET price_clp = 29990,  meta_included_usd = 10 WHERE plan = 'base'   AND price_clp IS NULL;
UPDATE plan_limits SET price_clp = 59990,  meta_included_usd = 25 WHERE plan = 'crece'  AND price_clp IS NULL;
UPDATE plan_limits SET price_clp = 99990,  meta_included_usd = 60 WHERE plan = 'equipo' AND price_clp IS NULL;

CREATE TABLE IF NOT EXISTS platform_module_flags (
  module_id   text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT true,
  kill_switch boolean NOT NULL DEFAULT false,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_audit (
  id         bigserial PRIMARY KEY,
  admin_user uuid NOT NULL,
  action     text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
