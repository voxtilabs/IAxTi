# @iaxti/db

Migraciones por módulo, contexto de tenant y RLS (SPEC §27, `.claude/rules/db.md`).

## Migraciones

- Viven en `packages/modules/<id>/migrations/*.sql`, se aplican en orden
  topológico de `depends_on.required` y, dentro del módulo, por nombre de
  archivo (`0001_...`, `0002_...`).
- **Solo aditivas.** Renombrar o borrar es en dos pasos con ventana de
  compatibilidad: (1) agregar lo nuevo + copiar datos + escribir en ambos;
  (2) en un release posterior, dejar de leer lo viejo y recién ahí borrarlo.
  La versión anterior de la app siempre funciona con el esquema nuevo — el
  rollback es solo de imagen (SPEC §37).
- Registro en `schema_migrations (module, version)`; serializado con
  advisory lock. Se aplican **antes** del deploy desde CI
  (`pnpm migrate:deploy`), nunca al arrancar el contenedor.

## Toda tabla de negocio

```sql
CREATE TABLE cosa (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  -- ...
);
CREATE INDEX cosa_tenant_idx ON cosa (tenant_id /* , resto del índice */);
ALTER TABLE cosa ENABLE ROW LEVEL SECURITY;
ALTER TABLE cosa FORCE ROW LEVEL SECURITY;   -- el dueño tampoco se salta RLS
CREATE POLICY tenant_isolation ON cosa
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Y todo acceso de la aplicación pasa por `withTenant(pool, tenantId, fn)`, que
fija `app.tenant_id` por transacción. Un test de aislamiento (tenant A no ve
B) es obligatorio por tabla nueva (`.claude/rules/testing.md`).

Dos trampas que el test de este paquete cubre y nadie debe reintroducir:

1. **El rol de la app jamás es superusuario ni dueño de las tablas.** Un
   superusuario se salta RLS por completo, y `FORCE` solo alcanza al dueño.
   En local el rol es `iaxti_app`; en Supabase, el rol de conexión de la API.
2. **`NULLIF(..., '')` en la política.** `current_setting(..., true)` devuelve
   cadena vacía (no NULL) en conexiones reusadas del pool, y `''::uuid`
   revienta la consulta en vez de devolver cero filas.

## Correr local

```bash
docker compose up -d postgres
pnpm --filter @iaxti/db build && pnpm --filter @iaxti/db test
DATABASE_URL=postgres://iaxti:iaxti@127.0.0.1:5432/iaxti pnpm migrate:deploy
```

## Ambientes

Supabase Cloud, un proyecto por ambiente (staging y prod), **misma región que
el VPS** (ADR-0002, SPEC §40). Los proyectos de Supabase aún no se crean:
cuando existan, `DATABASE_URL_STAGING`/`DATABASE_URL_PROD` van en los
environments de GitHub y los workflows ya los usan.
