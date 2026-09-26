-- El interruptor del Agente General (#496, ADR-0025).
--
-- Es SUYO y no el del módulo `agents`: apagar `agents` se llevaría también
-- al copiloto de la bandeja, que es lo que atiende clientes. Lo que este
-- interruptor apaga es la configuración por conversación, y apagarla deja
-- al producto como antes —pantallas y configurador—, no a oscuras.
--
-- Una fila por tenant, más la fila global con tenant_id NULL. Se guarda el
-- MOTIVO porque un interruptor sin motivo, a los tres días, nadie sabe si se
-- puede volver a encender.
CREATE TABLE IF NOT EXISTS agente_general_apagado (
  -- NULL = global: apaga para todos los negocios.
  tenant_id  uuid REFERENCES tenants (id) ON DELETE CASCADE,
  motivo     text NOT NULL,
  apagado_por uuid NOT NULL,
  apagado_el timestamptz NOT NULL DEFAULT now()
);

-- Un índice único que trate NULL como un valor: sin esto, dos filas globales
-- podrían convivir y la última en insertarse ganaría por azar.
CREATE UNIQUE INDEX IF NOT EXISTS agente_general_apagado_global_idx
  ON agente_general_apagado ((tenant_id IS NULL)) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agente_general_apagado_tenant_idx
  ON agente_general_apagado (tenant_id) WHERE tenant_id IS NOT NULL;

-- Tabla de PLATAFORMA, como `platform_module_flags`: no lleva RLS por tenant
-- porque no es de un tenant — la escribe el SuperAdmin y la lee la API con
-- el rol de la aplicación.
