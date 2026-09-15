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

```sql
CREATE ROLE iaxti_app LOGIN PASSWORD '<la de verdad, del gestor de secretos>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO iaxti_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO iaxti_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_app;

-- Para las tablas que vengan con las próximas migraciones:
ALTER DEFAULT PRIVILEGES FOR ROLE iaxti IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO iaxti_app;
ALTER DEFAULT PRIVILEGES FOR ROLE iaxti IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO iaxti_app;
```

`DATABASE_URL` de la aplicación apunta a `iaxti_app`. Las migraciones —que
corren antes del despliegue, en su propio paso— siguen usando el dueño.

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
