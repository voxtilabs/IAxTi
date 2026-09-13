# ADR 0012 · Cierre automático, archivo y retención de conversaciones

**Estado:** aceptada · 2026-09-13

## Contexto
"Inactividad" en una bandeja significa cerrar, no borrar: la conversación es el
historial del contacto y en un CRM ese historial es el activo. A la vez, la
retención es un atributo comercial del plan.

## Decisión
Tres mecanismos que no se confunden (SPEC §39): **cierre automático** (ADMIN:
`open`/`pending` sin entrante por N días → `resolved`; 7 por defecto),
**archivo** (ADMIN: `resolved` sin actividad por N meses → `archived_at`,
bandera sobre `resolved`, no un estado nuevo; 3 por defecto) y **retención**
(SUPERADMIN, por plan con override ≤ plan: borrado físico con
`last_message_at` anterior al corte; Base 12 · Crece 24 · Equipo ilimitada).
Los tres corren en `workers`, cola `scheduled`, job padre → hijo por tenant,
y auditan. Nunca `pg_cron` para la purga: debe auditar en la misma transacción,
borrar en R2 y respetar el kill-switch.

## Consecuencias
- `Conversation.last_message_at` (trigger) y `archived_at` existen desde la
  fase 1 del esquema; los jobs de cierre/archivo entran en fase 2 y la
  retención en fase 5 (no borra nada antes de los 12 meses del primer tenant).
- Bajar de plan avisa 30 días antes de la primera purga, con la cantidad
  exacta. Subir no recupera.
- `Contact`, `Deal` y `Appointment` no se tocan; la solicitud del titular
  (Ley 21.719) es un flujo aparte que borra todo en cualquier plan.

## Se revisa cuando
`messages` supere 20 millones de filas → particionado mensual (issue #84) y la
retención pasa a `DROP PARTITION`.
