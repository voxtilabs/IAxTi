-- Los medidores de uso se van con el tenant.
--
-- `usage_meters` apuntaba a `tenants` sin ON DELETE, así que borrar un tenant
-- fallaba si tenía consumo medido. Hasta ahora no se notaba porque el único
-- medidor que se escribía era el de IA; al empezar a contar conversaciones
-- (SPEC §9) aparece en cualquier limpieza.
--
-- CASCADE es lo correcto también fuera de los tests: un tenant `deleted` no
-- tiene por qué dejar sus contadores dando vueltas. Lo que se guarda para
-- facturación vive en billing, no acá.
DO $$
DECLARE
  nombre text;
BEGIN
  SELECT conname INTO nombre
    FROM pg_constraint
   WHERE conrelid = 'usage_meters'::regclass
     AND contype = 'f'
     AND confrelid = 'tenants'::regclass;
  IF nombre IS NOT NULL AND (
    SELECT confdeltype FROM pg_constraint WHERE conname = nombre AND conrelid = 'usage_meters'::regclass
  ) <> 'c' THEN
    EXECUTE format('ALTER TABLE usage_meters DROP CONSTRAINT %I', nombre);
    ALTER TABLE usage_meters
      ADD CONSTRAINT usage_meters_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;
