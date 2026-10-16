# Barrido de conteos en pruebas · #911

Revisión sobre `79936e77bfa57ebcfbcc16b81888af2fdb9983c7`. El objetivo es
identificar aserciones que confundan el trabajo de un caso con el estado de la
base compartida. No se ejecutaron todas las suites mencionadas abajo.

## Búsqueda

Se recorrieron `apps` y `packages`, archivos `*.test.ts`, buscando `count(`,
`.tenants`, `.cambiadas`, `.total`, contadores de barridos y aserciones sobre
`dispatcher.tick()`. Se inspeccionó el contexto de las coincidencias: un conteo
sin `WHERE tenant_id` puede estar correctamente acotado por un id único, un
esquema dedicado o RLS real. La búsqueda textual no demuestra ausencia de otros
casos expresados de otra forma.

```sh
rg -n 'count\(|\.tenants\)|\.cambiadas\)|\.total\)' --glob '*test.ts' apps packages
rg -n 'expect\(.*(enviados|avisados|tick\(|truncado|cambiadas)' --glob '*test.ts' apps packages
```

## Hallazgos

| Archivo / caso | Alcance observado | Resultado |
| --- | --- | --- |
| `apps/workers/tests/plantillas-sync.test.ts`, «sin nada en revisión» | Preparaba un tenant y esperaba `r.tenants === 0` y cero llamadas globales. | Corregido: observa llamadas por `senderId` único. Otro tenant tiene una plantilla pendiente durante toda la suite y sí consulta al proveedor. |
| Mismo archivo, aprobada / pendiente / proveedor caído | Miraba `r.cambiadas`, contador de todos los tenants. | Se conservan las aserciones de estado persistido por id de plantilla y se elimina la dependencia del contador global. El caso aprobado comprueba además las rutas de SU cuenta. |
| `packages/modules/platform/tests/salud.test.ts`, «una lista que NO está cortada» | Supone `truncado === false` para listas globales de webhooks y números en riesgo. | Riesgo pendiente: más de 20 grupos ajenos pueden invalidar la premisa. Conviene construir un rango controlado o comprobar el contrato de truncado contra la población consultada. No corregido en este PR. |
| `packages/modules/billing/tests/fin-de-ciclo.test.ts`, «la segunda pasada» | Compara antes/después de todos los avisos en `audit_log`. | No exige base vacía: el barrido anterior avisa todos los pendientes. Sigue expuesto a altas concurrentes entre pasadas. Conviene afirmar sobre los tenants creados por la prueba. No corregido aquí. |
| `packages/modules/calendar/tests/recordatorios.test.ts`, «cada aviso UNA vez» | Compara el contador global con llamadas del callback y espera cero en segunda pasada. | No exige una cantidad fija de datos previos, pero consume también recordatorios ajenos y depende de que no aparezca trabajo concurrente. La prueba «SIN recordatorio» devuelve `false` para TODOS los tenants, por eso su cero global es coherente con ese doble. |
| `packages/core/tests/outbox.test.ts` | Espera cantidades exactas de `dispatcher.tick()` después de `drenar()`. | El drenaje elimina la dependencia de pendientes antiguos, pero consume trabajo global y no aísla productores concurrentes. Pendiente de aislar si se ejecuta con productores simultáneos. |
| `packages/modules/platform/tests/salud.test.ts`, total de denegaciones / grupos | Compara contra un SQL independiente con el mismo rango global. | No presupone base virgen; prueba un contrato global. Una escritura concurrente entre ambas lecturas puede cambiar la foto. |
| `packages/modules/crm/tests/contacts.test.ts`, aislamiento | `count(*) FROM contacts` sin filtro SQL, ejecutado con rol de aplicación y `withTenant`. | Intencional: prueba RLS. No agregar filtro de tenant, porque ocultaría una regresión de RLS. |
| `packages/db/tests/rls-rol-honesto.test.ts`, `rls.test.ts` | Consultas sin filtro con rol sin bypass, con/sin contexto. | Intencional: los conteos son evidencia del aislamiento, no una suposición de base vacía. |
| `packages/modules/knowledge/tests/migracion-0002.test.ts` | Conteos sin filtro de tenant en esquema `antes_de_0002`. | Acotado por `search_path`; no cuenta las tablas de `public`. El nombre fijo del esquema puede colisionar entre dos procesos de ESA suite, un problema distinto. |
| `packages/db/tests/blindaje.test.ts` | `count(*) FROM tenants >= 0`; consulta de políticas duplicadas. | Verifica acceso/catálogo, sin depender de un número fijo de tenants. |
| `packages/modules/calendar/tests/cancelacion.test.ts`, `automations/tests/campanas.test.ts`, `seed/tests/demo.test.ts` | Totales por tenant, campaña, id propio o comparación antes/después del mismo seed. | No se encontró la suposición de que el total de toda la base deba coincidir con el fixture de un tenant. |

## Regresión ejercitada

Con PostgreSQL real, se dejó una plantilla pendiente de un tenant de una corrida
anterior. La prueba original falló con `expected 1 to be +0`. La versión corregida
pasa repetidamente sobre esa misma base. Su fixture ajeno adicional tiene cuenta
activa, de modo que el caso verifica simultáneamente que el barrido consulta al
negocio con trabajo y no consulta al negocio sin plantillas pendientes.
