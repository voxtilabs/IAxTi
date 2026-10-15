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
- **LEER tablas de otro módulo: solo de lo que DECLARÁS.** Si el módulo está en
  tu `depends_on` (`required` u `optional`), leer sus tablas se permite y el
  manifiesto es donde queda documentado. Si no lo declarás, no: declaralo, o
  pedile los datos por contrato o por evento. Prefiere igual el contrato o el
  evento cuando alcancen; un `JOIN` que cruza es una dependencia sobre un
  esquema ajeno y se paga el día que ese módulo migre.
- **ESCRIBIR en tablas de otro módulo (`UPDATE`, `INSERT`, `DELETE`): no, lo
  declares o no.** Declarar dice «dependo de este esquema», y eso no alcanza
  para escribirlo: una escritura ajena rompe sus invariantes y su auditoría sin
  pasar por su código, y su dueño no se entera. Lo que necesitás es un contrato
  del módulo dueño; si tiene que ser atómico con lo tuyo, que reciba tu
  `PoolClient` y corra en tu transacción.
  Las dos mitades no son un ideal: las sostiene
  `packages/core/tests/consultas-entre-modulos.test.ts` con el trinquete de
  `docs/consultas-entre-modulos.txt`, donde cada excepción tiene su motivo y su
  issue — y no puede ser una más. **Medido el 14/10:** cruzan 35 pares de
  módulos y 81 consultas archivo-tabla, de las cuales 13 son escrituras (10 de
  los 35 pares). Por eso la línea quedó donde quedó: prohibir las escrituras
  costaba 10 excepciones y prohibir las lecturas sin declarar, 19; prohibirlo
  todo —que es lo que esta regla decía antes, «consultas de otro módulo:
  prohibidas»— costaba los 35. Una regla que la mayoría incumple obliga a cada
  PR a elegir entre romperla o pagar un refactor que nadie pidió, y lo que se
  elige es romperla. No la vuelvas a escribir sin matices (#784).
- `Conversation` mantiene `last_inbound_at` (ventana 24 h), `last_message_at`
  (trigger en Message) y `archived_at` (SPEC §39) con sus índices.
