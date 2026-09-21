-- El rol con el que la aplicación se conecta a Postgres (#370).
--
-- Esto estaba escrito en el runbook y en ninguna otra parte, o sea que cada
-- ambiente lo aplicaba a mano y ninguno igual que el anterior. Acá está una
-- sola vez, es idempotente, y se puede volver a correr después de cada
-- migración sin pensarlo.
--
-- Cómo se corre (la contraseña NUNCA va en este archivo ni en Git):
--
--     psql "$DATABASE_URL_DUENO" \
--       -v rol=iaxti_app -v clave="$CLAVE_DEL_GESTOR_DE_SECRETOS" \
--       -f infra/sql/rol-de-la-aplicacion.sql
--
-- Después, y ANTES de apuntar la aplicación al rol nuevo:
--
--     pnpm --filter @iaxti/db run permisos    # conectado como el rol nuevo
--
-- El orden importa: el rol tiene que existir ANTES de correr las
-- migraciones, porque el GRANT de `resolver_api_key` vive dentro de un
-- IF EXISTS (… pg_roles …) y si el rol no está se salta en silencio. Los
-- GRANT de abajo reparan ese caso si ya pasó.

\set ON_ERROR_STOP on

-- psql NO reemplaza variables dentro de un bloque $$…$$ —las trata como
-- texto literal—, así que el "si no existe, créalo" se hace con \if, que sí
-- las ve. Escrito con un DO se creaba un rol llamado, literalmente, :'rol'.
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rol') AS hay_que_crearlo \gset

\if :hay_que_crearlo
CREATE ROLE :"rol" LOGIN PASSWORD :'clave' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
\else
-- Ya existía: se le quita lo que no debería tener nunca. Un rol que alguien
-- creó a la rápida con SUPERUSER es exactamente el caso que este archivo
-- viene a arreglar.
ALTER ROLE :"rol" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE :"rol" LOGIN PASSWORD :'clave';
\endif

GRANT USAGE ON SCHEMA public TO :"rol";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"rol";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"rol";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"rol";

-- Los libros son append-only. El trigger ya rechaza UPDATE y DELETE; el
-- permiso tampoco tiene por qué estar. Dos cerraduras cuestan lo mismo.
REVOKE UPDATE, DELETE ON audit_log FROM :"rol";
REVOKE UPDATE, DELETE ON platform_audit FROM :"rol";

-- Las migraciones no las corre la aplicación: su tabla es del dueño.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM :"rol";

-- Para lo que traigan las migraciones que vengan. Va DESPUÉS de los GRANT
-- de arriba a propósito: esto solo alcanza a lo que se cree de acá en
-- adelante, no a lo que ya existe.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"rol";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"rol";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"rol";

-- Lo que tiene que verse al final: las dos banderas en false.
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = :'rol';
