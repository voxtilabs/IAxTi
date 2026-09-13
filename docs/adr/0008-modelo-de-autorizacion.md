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
- `permission.denied` es un evento que alimenta el panel de seguridad.

## Se revisa cuando
Nunca el principio; el catálogo evoluciona con los manifiestos.
