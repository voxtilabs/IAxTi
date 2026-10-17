# #80 · evidencia del derivado estructural local

La herramienta y sus límites están en [scripts/dr](../../../scripts/dr/README.md).
No se usó producción, backups reales, Supabase, Redis/R2 ni servidores externos.
No se ejecutó el restore mensual ni se demostró RPO/RTO. C3 continúa parcial.

## Verificación local

En PostgreSQL 16 del clúster local de pruebas, con el esquema integrado de 113
migraciones y datos ficticios: **26/26 pruebas** (22 SQL y 4 puras), sin omitidas. La corrida final del
implementador duró 27,47 s; es tiempo de pruebas, **no RTO**. La repetición
independiente también aprobó 26/26 sobre los mismos archivos.

- Dos tenants y relaciones en las 12 tablas; FK simples/compuestas y pertenencia
  al tenant verificadas, UUIDs nuevos en cada exportación.
- Marcadores ficticios en contenido, JSON, adjuntos, teléfono/correo, importes,
  auditoría, outbox, API keys, cuentas, invitaciones y Auth/Storage: ausentes del
  artefacto. El origen permanece intacto y cada SELECT de negocio corre en una
  transacción real de solo lectura, limitada a las claves previstas.
- Rechazo de rol sujeto a filtrado RLS y de nuevos esquemas, tablas, columnas,
  vistas, policies, RLS desactivado y triggers desactivados, sin archivo resultante.
  Incluye los 580 triggers internos de FK, comparados con claves estables sin OIDs;
  su desactivación se rechaza tanto en origen como en destino.
- Esquema base 97 rechazado con `DR_SCHEMA_UNSUPPORTED`, sin fingir compatibilidad.
- Archivo 0600, no sobrescritura; rechazo de symlink, permisos abiertos, contenido
  alterado y referencia entre tenants antes de escribir en destino.
- Origen=destino, destino ocupado o catálogo inicial personalizado rechazados.
- Cierre desde conexión de control confirmado antes de escribir; nuevas
  conexiones rechazadas; otra sesión aborta; una inserción intercalada entre
  precheck y cierre queda conservada y cancela la importación.
- Error inyectado a mitad de carga: rollback real, catálogos previos intactos,
  destino bloqueado. Triggers/constraints activos incluso si la sesión recibió
  `session_replication_role=replica`; fechas del trigger vuelven a las constantes
  sintéticas. Valores finales comparados, no solo conteos.
- Subproceso con desconexión real de un cliente idle: salida 1 y código fijo,
  sin URL/contraseña ni el objeto `client`. URL inválida también falla sin revelar
  la credencial sintética usada por la prueba.

Las corridas iniciales fallidas se conservaron en la evidencia de trabajo:
fixtures usaban `amount` en vez de `value`, una invitación sin correo/teléfono
ni token único, y un hash de API key duplicado. La ejecución también detectó
que `name[]` se recibía como texto (corregido a `text[]`) y que el trigger de
mensajes modificaba tres fechas de conversación (normalizadas antes de validar).
La primera repetición independiente encontró además que una prueba adversarial
seleccionaba la conversación ajena por índice de UUID aleatorio: ahora exige
explícitamente un `tenant_id` distinto. Su contraprueba también demostró que
`DISABLE TRIGGER ALL` apagaba FK internas sin cambiar el catálogo inicial: se
incorporaron al catálogo y se añadió regresión de origen y destino. No se
rebajaron aserciones ni se desactivaron constraints del importador para aprobar.

## Revisiones y alcance

- `module-check`: scripts de operación local; no endpoints, imports entre
  módulos, contratos, permisos, eventos o manifiestos de aplicación nuevos.
- `security-review`: catálogo cerrado, fuente read-only/RLS fail-closed,
  identidad del destino, cierre efectivo, rollback, archivo privado, exclusiones
  y errores sin objetos de conexión. La fila de backups en
  [COMPLIANCE_BASELINE](../../COMPLIANCE_BASELINE.md) conserva el estado parcial.
- `ui-check` y `rule-check`: no UI, IA, mensajería, cobros ni llamadas externas.
- No se escribe auditoría de producción ni se reconstruye su cadena: queda
  íntegra en la copia original; las filas de audit/outbox se excluyen del derivado.
- Crítica independiente: cierre desde otra base/autocommit, carrera entre
  precheck y cierre, RLS y triggers internos. Los contraejemplos quedaron
  corregidos y repetidos; sin hallazgos bloqueantes abiertos en el corte final.
- Verificación independiente: 26/26 tests, contraprueba de FK internas rechazada
  en ambos destinos y CLI real `export`/`import` con fila ficticia, origen
  intacto, gate cerrado y nueva conexión rechazada con SQLSTATE 55000.
- `pnpm lint`: 0 errores, 4 advertencias preexistentes. Los MJS están excluidos
  por el lint general del repo: adicionalmente se corrió ESLint dirigido con
  `--no-config-lookup --no-ignore --rule 'no-unused-vars:error' scripts/dr/*.mjs`,
  `node --check`, `git diff --check` y validación de 24 enlaces locales, verdes.
- No se repitió el preflight monorepo: no cambia código de aplicaciones,
  dependencias ni migraciones. La evidencia SQL del esquema 113 es local; el
  workflow nuevo ejecuta los 4 tests puros, no declara esa SQL verificada en CI.
- Los agentes reutilizados comparten contexto; la autoría y verificación son
  distintas, no se afirma aislamiento de contexto nuevo.

La cantidad y topología de las filas pueden revelar patrones. La ausencia de
marcadores demuestra estas transformaciones, no anonimato formal de cualquier
backup. Se conservan pendientes Auth/Storage sintéticos, revinculación, revisión
de privacidad, smoke real y los criterios externos de #80.

## Trazabilidad con la issue completa

| Criterio original | Evidencia de este cambio | Estado |
|---|---|---|
| C1 · PITR Supabase cronometrado | No se conecta Supabase ni se restaura backup real | Pendiente externo |
| C2 · Redis/R2 y VPS limpio | No cambia ni ensaya esos recursos | Pendiente externo |
| C3 · Staging mensual desde backup anonimizado | Checklist, catálogo cerrado, derivado de 12 tablas y pruebas sintéticas; omisión de las otras 84 y Auth/Storage | Parcial; revisión de privacidad, identidades/archivos sintéticos, restore y smoke real pendientes |
| C4 · Rollback <2 min | Conserva comentario histórico: 192 s sin caché /24 s con caché y desvío #181 | Evidencia histórica; no reensayado ni declarado corregido |
| C5 · RPO5min/RTO1h y desvíos | No se usa duración de tests como RPO/RTO | No demostrado en este cambio |
