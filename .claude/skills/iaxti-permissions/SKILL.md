---
name: iaxti-permissions
description: Catálogo de permisos y guards de IAxTi. Usar al agregar endpoints, permisos, roles, API keys, o tools de IA que necesiten autorización.
---

# Permisos y guards

Modelo completo en SPEC §27 y ADR-0008. Regla de oro: NUNCA `if (role ===
'...')` — roles son paquetes de permisos, el código verifica permisos.

## Formato y origen

Permiso: `<módulo>.<recurso>.<acción>` (ej. `crm.contacts.update`). Se declara
en el `module.yaml` del módulo dueño; el catálogo se regenera al arrancar. No
existe "agregar un permiso en código".

## El guard, siempre completo

```ts
@RequireModule('crm')                       // módulo activo para el tenant
@RequirePermission('crm.contacts.update')   // permiso en el rol del actor
async update(@Tenant() t, @Actor() a, @Param('id') id, dto) {
  // + verificación de dueño/equipo cuando el recurso lo exige
}
```

Sin permiso → 403 con formato único + evento `permission.denied`. Módulo
apagado → `MODULE_DISABLED`. RLS es la segunda cerradura: el guard nunca la
reemplaza ni al revés.

## Quién porta permisos

- Usuarios: rol por tenant (base o custom clonado). Matriz de referencia en
  SPEC §23.
- API keys: scopes = subconjunto del catálogo; `actor_kind = apikey` en audit.
- Agentes: la identidad del usuario que conversa (`on_behalf_of`); jamás un
  "rol de bot".
- SuperAdmin: permisos `platform.*`, cross-tenant, todo auditado.

## Checklist al agregar un endpoint

1. Permiso declarado en el manifiesto (¿existe uno que ya calza? no dupliques).
2. Guards completos + verificación de objeto si aplica.
3. Test: con permiso pasa, sin permiso 403, módulo apagado MODULE_DISABLED.
4. OpenAPI actualizado.
