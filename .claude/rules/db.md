# Regla: base de datos

- Migraciones por módulo en `packages/modules/<id>/migrations/`, versionadas,
  SOLO aditivas. Renombrar o borrar es una migración en dos pasos con ventana
  de compatibilidad (la versión anterior de la app debe funcionar con el
  esquema nuevo — el rollback es solo de imagen).
- Toda tabla de negocio: `tenant_id` NOT NULL + política RLS que lo use +
  índice que empiece por `tenant_id`. Sin excepciones; si crees que la tuya lo
  es, ADR.
- Timestamps en UTC (`timestamptz`); la zona del tenant es de presentación.
- Teléfonos en E.164. Montos con moneda; UF guarda también el valor CLP del
  día.
- `audit_log`: append-only; el rol de aplicación no tiene UPDATE ni DELETE.
- Cache en Redis: claves SIEMPRE prefijadas por tenant.
- pgvector con `tenant_id` y RLS igual que el resto.
- Las migraciones se aplican ANTES del deploy, desde el Action con lock; nunca
  al arrancar el contenedor.
- Consultas de otro módulo: prohibidas. Si necesitas sus datos, contrato o
  evento.
- `Conversation` mantiene `last_inbound_at` (ventana 24 h), `last_message_at`
  (trigger en Message) y `archived_at` (SPEC §39) con sus índices.
