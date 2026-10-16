# ADR 0008 · Roles como paquetes de permisos, doble cerradura

**Estado:** aceptada · 2026-09-13

## Contexto
`if (role === 'ADMIN')` esparcido por el código hace imposible auditar quién
puede qué, e impide roles personalizados por tenant.

## Decisión
Permisos `<módulo>.<recurso>.<acción>` generados desde los manifiestos, nunca a
mano. Roles base (SUPERADMIN, ADMIN, SUPERVISOR, USER) como paquetes de
permisos; custom por clonación (v2). Guard único:
`@RequireModule` + `@RequirePermission` + tenant + dueño/equipo del objeto.
RLS en Postgres (`SET app.tenant_id`) como segunda cerradura. Las tools de los
agentes pasan por el mismo guard con la identidad del usuario (`on_behalf_of`);
las API keys con scopes e identidad propia (`actor_kind = apikey`). Toda
mutación importante escribe en `audit_log` (append-only, hash encadenado) en la
misma transacción.

## Consecuencias
- Prohibido condicionar por rol en código; verificable con grep en CI.
- El SuperAdmin es cross-tenant y cada acción suya queda en audit.
- El rechazo de permiso va al libro de auditoría (`action = 'permission.denied'`)
  y el panel de seguridad lo lee de ahí: una fuente, no dos. No es un evento del
  catálogo; esta línea decía que sí y nadie lo publicaba ni lo consumía (#793).

## Se revisa cuando
Nunca el principio; el catálogo evoluciona con los manifiestos.

## Lectura de membresías antes de elegir negocio (#902)

`GET /me` valida la sesión primero y usa `withAuthenticatedUser`: fija
`app.user_id` con alcance de transacción, sin tenant. Dos políticas SELECT
permiten leer únicamente sus membresías y sus roles propios. No conceden
escritura ni acceso a conversaciones/contactos sin `app.tenant_id`; dentro de
un tenant no amplían la política de ese negocio. Commit y rollback liberan el
contexto antes de devolver la conexión al pool. El identificador sale del JWT
verificado, jamás de parámetros de la petición. No se usa un rol privilegiado.

`authorization` es dueño de las lecturas de pertenencia y traduce el permiso
con el mismo catálogo y reglas del guard. Asignación y revocación reciben el
cliente de la transacción ajena y serializan los cambios de membresía por
negocio para conservar a quien administra. Identity añade perfiles y nombres;
conversations pide `conversations.reply` y notifications pide
`conversations.assign` o `tenant.settings`, según el aviso. Los roles propios
con esos permisos participan sin tener que llamarse ADMIN o SUPERVISOR.

## Alta inicial autenticada (#56)

`POST /onboarding/registro` extiende ese bootstrap: exige JWT incluso en
desarrollo y no acepta ids, roles ni plan del cuerpo. Antes de que exista un
negocio no puede exigirse un permiso de ese negocio. Un bloqueo transaccional
por usuario serializa el alta; si ya es miembro, conserva su pertenencia y rol.
Para un usuario nuevo, el servidor genera el id y fija el contexto de tenant
antes de crear outbox, perfil, membresía ADMIN y auditoría en la misma transacción.
Crece y los 14 días de trial son las reglas existentes de SPEC §6.

`initial_business_registrations` conserva la referencia del alta inicial para
reintentos, incluso tras recibir otras invitaciones. Tiene RLS por tenant y
lectura de la referencia propia desde `app.user_id`, sin abrir datos del negocio.
La referencia no concede membresía: si su acceso fue revocado, el reintento
devuelve rechazo y no lo reincorpora. Ni cookies ni API keys ni headers de
desarrollo pueden activar este bootstrap. No se usa `BYPASSRLS` ni una función
con privilegios del dueño. La descripción queda en la configuración del negocio;
no se publica como configuración aplicada antes de revisar el diff.
