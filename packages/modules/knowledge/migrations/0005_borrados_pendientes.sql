-- La ventana invisible entre borrar el archivo y confirmar (#751).
--
-- `eliminarFuente` borra el archivo en R2 DENTRO de la transacción y después
-- confirma (#630: el archivo primero, porque una fila sin archivo se arregla
-- y un archivo sin fila queda bajable para siempre). Si el proceso muere en
-- el medio —un OOM kill, un deploy, el contenedor que se va— nadie marca
-- nada: la fila vuelve en `active`, sin archivo, y SE CITA IGUAL.
--
-- Anotar la intención sobre la misma fila no sirve: la transacción que está
-- borrando tiene el candado, así que una conexión aparte se quedaría
-- esperando justo el momento que se quiere adelantar. Por eso una tabla
-- propia, escrita ANTES de tocar R2 y en su propia transacción.
--
-- Lo que el barrido hace con esto está en `reconciliarBorradosPendientes`, y
-- lo que NO hace es lo que vuelve seguro todo el mecanismo: no borra archivos.
-- Solo cuenta lo que pasó.
CREATE TABLE IF NOT EXISTS pending_file_deletions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  source_id    uuid NOT NULL,
  r2_key       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Se llena cuando el borrado terminó bien. Una fila con esto puesto es
  -- historia; el barrido mira las que lo tienen en NULL.
  confirmed_at timestamptz
);

-- Empieza por tenant_id, como toda tabla de negocio, y acota al barrido a lo
-- que de verdad quedó colgando.
CREATE INDEX IF NOT EXISTS pending_file_deletions_pendientes
  ON pending_file_deletions (tenant_id, created_at)
  WHERE confirmed_at IS NULL;

ALTER TABLE pending_file_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_file_deletions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pending_file_deletions_por_tenant ON pending_file_deletions;
CREATE POLICY pending_file_deletions_por_tenant ON pending_file_deletions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
