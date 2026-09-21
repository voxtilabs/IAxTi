# El rol con el que la aplicación se conecta a Postgres

**La aplicación jamás se conecta con el usuario dueño de la base.**

## Por qué

Postgres **no evalúa las políticas de RLS** cuando el rol que conecta es
superusuario o tiene `BYPASSRLS`. Da lo mismo que la tabla tenga `ENABLE ROW
LEVEL SECURITY` y `FORCE`, y que la política esté bien escrita: no se mira, y
no avisa.

El aislamiento entre tenants —que los mensajes de una peluquería no se vean
desde la cuenta de otra— depende entonces de una sola cosa: con qué usuario
conecta la aplicación.

Comprobado contra las políticas tal cual están en el repo:

```
superusuario con app.tenant_id = A ve 1 contactos (del tenant B)
iaxti_app     con app.tenant_id = A ve 0 contactos
```

El peligro concreto: un Postgres levantado por Dokploy entrega por defecto un
usuario **superusuario**. Apuntar ahí `DATABASE_URL` desactiva el aislamiento
sin un error, sin un aviso y sin que ningún test se ponga rojo.

## Cómo queda bien

Dos roles, con trabajos distintos:

| Rol | Para qué | Privilegios |
|---|---|---|
| dueño (`iaxti`) | crear la base y correr migraciones | DDL, dueño de las tablas |
| aplicación (`iaxti_app`) | todo lo que corre en vivo: API, workers, agentes | DML, **sin** superusuario ni BYPASSRLS |

El SQL vive en el repo, no en este documento: `infra/sql/rol-de-la-aplicacion.sql`.
Estaba escrito acá y en ninguna otra parte, así que cada ambiente lo aplicaba
a mano y ninguno quedaba igual que el anterior.

```bash
psql "$DATABASE_URL_DUENO" \
  -v rol=iaxti_app -v clave="$CLAVE_DEL_GESTOR_DE_SECRETOS" \
  -f infra/sql/rol-de-la-aplicacion.sql
```

Es idempotente y se puede volver a correr después de cada migración. Si el rol
ya existía, además le QUITA lo que no debería tener: un `iaxti_app` creado a
la rápida con `SUPERUSER` es justamente el caso que esto viene a arreglar.

Concede las cuatro operaciones en todas las tablas, `USAGE, SELECT` en las
secuencias y `EXECUTE` en las funciones, y después revoca lo que no va:
`UPDATE`/`DELETE` en los dos libros de auditoría —son append-only, y el
trigger que ya los rechaza es la otra cerradura— y toda escritura en
`schema_migrations`, que es del dueño.

## Antes de apuntar la aplicación al rol nuevo

```bash
DATABASE_URL="postgres://iaxti_app:...@host/base" pnpm --filter @iaxti/db run permisos
```

Se conecta CON EL ROL NUEVO, no escribe nada, y responde una de dos cosas:

```
rol "iaxti_app"
  respeta RLS.
  no le falta ningún permiso.
  LISTO para ser el rol de la aplicación.
```

o la lista de lo que falta, con el nombre del objeto y qué se rompe sin él:

```
  FALTA  INSERT en tabla contact_identities — La aplicación falla con
         "permission denied for table contact_identities".
```

Sale con código 1 cuando falta algo, y el despliegue de staging lo corre
después de migrar (paso «Permisos del rol de la aplicación»), porque el
momento en que esto se rompe es justo después de una migración que trajo una
tabla nueva. La lista de tablas no está escrita a mano en ningún lado: se le
pregunta al catálogo, así que una migración futura queda cubierta sola.

> **El orden importa.** El rol se crea ANTES de correr las migraciones. Si se
> hace al revés, el `GRANT EXECUTE` que la migración de `resolver_api_key`
> intenta se salta en silencio —está dentro de un `IF EXISTS (… pg_roles …)`—
> y las API keys dejan de funcionar sin que nada lo diga. El
> `GRANT EXECUTE ON ALL FUNCTIONS` de arriba lo repara si ya pasó.

`DATABASE_URL` de la aplicación apunta a `iaxti_app`. Las migraciones —que
corren antes del despliegue, en su propio paso— siguen usando el dueño.

### Lo que NO alcanza con tener permisos

Los permisos son una cosa y el contexto de tenant es otra. Una consulta que
la aplicación haga **fuera** de `withTenant` corre sin `app.tenant_id`, y con
RLS forzado eso devuelve **cero filas** — no un error. Con el rol de
desarrollo, que es superusuario, la misma consulta devuelve todo.

Esa diferencia dejó muertos todos los barridos programados hasta #286:
facturación, recordatorios, reglas de tiempo, secuencias, webhooks y
analytics corrían cada 15 minutos informando que no había nada que hacer.

Hay un test que lo cuida (`packages/db/tests/barridos-con-el-rol-real.test.ts`):
corre con un rol sin privilegios y falla si alguien vuelve a consultar una
tabla con RLS fuera de `withTenant`.

Si en vez del `GRANT … ON ALL TABLES` se prefiere enumerar tabla por tabla,
hay que acordarse de que el camino de entrada de un mensaje escribe en más
lugares de los que parece: además de `contacts`, `conversations` y
`messages`, toca `contact_identities`, `assignments`, `outbox` y
`usage_meters` (esta última desde que cada conversación cuenta como activa
del ciclo). Los tests de `conversations` enumeran ese mínimo: si algo falta,
fallan con `permission denied` y ahí queda la lista al día.

## El guardián

La API y los workers comprueban al arrancar si la conexión puede saltarse
RLS (`exigeRolQueRespetaRls`, issue 211). Si puede, **gritan** al partir y
cada media hora:

```
SIN AISLAMIENTO (staging): La base acepta esta conexión con el rol "…"
```

**No matan el proceso, en ningún entorno.** Matarlo suena decidido y es
peor: el contenedor entra en ciclo de reinicio, el proxy le quita la ruta y
lo que ve cualquiera es un 404 pelado, con el motivo real enterrado en un
log al que hay que entrar a buscar. Pasó con staging el 15/09.

Lo que corresponde en producción —negarse a servir con el proceso vivo— va
en el issue 227.

Si la base no contesta cuando se hace la comprobación, la aplicación
arranca igual y lo dice: una comprobación de seguridad no puede volverse una
dependencia dura del arranque (`/health` es liveness justamente para no
tener ninguna).

## Supabase, que es el caso nuestro

En Supabase el rol `postgres` —el que viene en la cadena de conexión que
entrega el panel— **no es superusuario, pero tiene `BYPASSRLS`**. El efecto
es idéntico: las políticas no se evalúan.

Es decir: pegar la URL que Supabase da por defecto en `DATABASE_URL` deja la
aplicación sin aislamiento entre tenants, silenciosamente. Hay que crear el
rol de aplicación igual que en un Postgres propio:

```sql
CREATE ROLE iaxti_app LOGIN PASSWORD '<del gestor de secretos>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

y dárselo a la app; `postgres` queda solo para migraciones.

**Producción no va a servir nada hasta que esto esté hecho** (issue 227):
responde 503 con `SIN_AISLAMIENTO` en vez de entregar datos que podrían ser
de otro cliente. No es un contratiempo del despliegue: es la única respuesta
correcta.

## Cómo comprobarlo a mano

```sql
SELECT current_user, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname = current_user;
```

Las dos banderas tienen que venir en `false`.
