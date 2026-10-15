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
- **Consultas a tablas de otro módulo: solo de lo que DECLARÁS.** Si el módulo
  está en tu `depends_on` (`required` u `optional`), consultar sus tablas se
  permite y el manifiesto es donde queda documentado. Si no lo declarás, no:
  declaralo, o pedile los datos por contrato o por evento. Prefiere igual el
  contrato o el evento cuando alcancen; un `JOIN` que cruza es una dependencia
  sobre un esquema ajeno y se paga el día que ese módulo migre — y escribir en
  la tabla de otro (`UPDATE`, `INSERT`, `DELETE`) rompe además sus invariantes y
  su auditoría sin pasar por su código.
  Esto no es un ideal: lo sostiene `packages/core/tests/consultas-entre-modulos.test.ts`
  con el trinquete de `docs/consultas-entre-modulos.txt`. **Medido el 14/10:**
  cruzan 35 pares de módulos; 16 ya lo declaraban, y los 19 que no, están en esa
  lista con su motivo — y no pueden ser 20. Antes esta regla decía «consultas de
  otro módulo: prohibidas», con 35 pares rompiéndola: una regla que la mayoría
  incumple obliga a cada PR a elegir entre romperla o pagar un refactor que
  nadie pidió, y lo que se elige es romperla. No la vuelvas a escribir sin
  matices (#784).
- `Conversation` mantiene `last_inbound_at` (ventana 24 h), `last_message_at`
  (trigger en Message) y `archived_at` (SPEC §39) con sus índices.
