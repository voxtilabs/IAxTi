-- El aviso antes del borrado (issue 218, SPEC §6).
--
-- El ciclo termina en `suspended → deleted` a los 90 días, "con exportación
-- ofrecida antes". La decisión tomada es que el sistema AVISA y una persona
-- borra: el borrado es irreversible y se lleva datos de los clientes de
-- nuestro cliente. Un error de fecha o una factura pagada que no se
-- registró terminan en datos que no vuelven.
--
-- Esta columna existe para que el aviso se mande UNA vez y no todos los
-- días del barrido. Sin ella, la única forma de saber si ya se avisó sería
-- buscar en audit_log, que no es un índice.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deletion_warned_at timestamptz;

-- El listado del SuperAdmin ordena por antigüedad de la suspensión.
CREATE INDEX IF NOT EXISTS tenants_suspendidos_idx
  ON tenants (state_since) WHERE state = 'suspended';
