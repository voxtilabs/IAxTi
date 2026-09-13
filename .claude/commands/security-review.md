---
description: Revisión de seguridad del diff actual según las reglas del proyecto
---

Revisa el diff actual (o `$ARGUMENTS` si se indica un rango/PR) contra
`.claude/rules/seguridad.md` y `docs/SECURITY_BASELINE.md`:

1. Endpoints: ¿todos con `@RequireModule` + `@RequirePermission` + tenant +
   objeto? ¿Algún `if (role`?
2. Tablas nuevas: ¿`tenant_id` + RLS + índice? ¿Migración aditiva?
3. Mutaciones: ¿audit_log en la misma transacción?
4. Secrets: ¿algo parecido a un token, key o URL interna en el diff?
5. Webhooks: ¿firma verificada sobre raw body, encolado, idempotente?
6. Tools de IA: ¿pasan por el guard? ¿alguna borra? ¿alguna cruza tenants?
7. PII: ¿algo nuevo viaja a Langfuse/proveedores sin redacción?
8. Dependencias nuevas: ¿justificadas, mantenidas, sin alternativa ya presente?

Reporta hallazgos por severidad con archivo:línea y el arreglo concreto. Si
tocaste datos personales o IA, indica qué fila de COMPLIANCE_BASELINE.md hay
que actualizar. Sin hallazgos: dilo explícitamente y qué verificaste.
