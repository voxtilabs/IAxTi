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

## El guardián

La API y los workers **no arrancan en `production`** si la conexión se puede
saltar RLS (`exigeRolQueRespetaRls`, issue 211).

En `staging` y en desarrollo sí arrancan, pero gritan en el log al partir y
cada media hora:

```
SIN AISLAMIENTO (staging): La base acepta esta conexión con el rol "…"
```

La razón de la diferencia es que en staging no hay datos reales —nunca un
número de WhatsApp de verdad— y tumbar el ambiente no protegería a nadie.
Que el aviso esté ahí no lo vuelve aceptable: **staging también tiene que
usar el rol de aplicación**, y mientras no lo use, el aislamiento entre
tenants no se está probando en ninguna parte salvo en los tests de RLS.

Si el arranque en producción falla con

> La base acepta esta conexión con el rol "…", que es superusuario

no hay que apagar el guardián: hay que crear el rol de aplicación.

## Cómo comprobarlo a mano

```sql
SELECT current_user, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname = current_user;
```

Las dos banderas tienen que venir en `false`.
