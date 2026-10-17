# Estados y medidas de las cinco pantallas de #588

La campana mostraba «Nada nuevo por ahora» mientras el arranque seguía en vuelo, ocultaba errores de sondeo y permitía perder el error de marcado al navegar. Ahora distingue carga, vacío, datos, falta de permiso y fallo recuperable. Conserva los últimos avisos frente a un 500; los descarta ante un 403 o cambio de negocio/sesión. El error conserva `code · requestId`. Abrir un aviso espera el marcado y su refresco; un fallo permanece visible y permite reintentar. Ctrl/Cmd/Shift conservan la apertura nativa del enlace.

El arranque expone una respuesta solo cuando coincide su negocio y sesión. Las pruebas DOM resuelven respuestas viejas después de cambiar ambos contextos. El menú registra los avisos como opciones de Radix y permite Tab/Shift+Tab hacia las acciones compartidas de vacío y error; flechas y Escape también están probados.

## Criterios originales y evidencia

| Criterio de #588 | Cambio y evidencia |
| --- | --- |
| La guarda falla con una pantalla nueva sin vacío ni esqueleto | `listas-sin-estados.test.ts` crea una pantalla temporal que falla ambos detectores, incluso con los nombres de componentes escritos en un comentario; al añadir los estados reales deja de fallar. |
| Los pendientes tienen motivo | Las 31 entradas del trinquete generado están descritas individualmente en `docs/listas-sin-vacio-motivos.json`, con anclas de código verificadas por 32 pruebas. No se cambió el comportamiento de esas pantallas. |
| Las cinco listas tienen vacío y esqueleto | Campana, Evaluaciones, Recordatorios y Auditoría usan `EstadoVacio` y carga diferenciada. Retención es un formulario: `months: null` significa «sin límite», no ausencia de registros; se conserva ese contrato y se mide su carga, sin inventar un vacío. |
| Altura medida | 18 comparaciones del mismo marco a 360 px, con datos y con vacío donde existe. [Medidas completas](medidas.json). Tolerancia de la suite: 16 px; diferencia máxima observada menor de 0,001 px. |
| Día/noche, 360 px y foco | Las cinco pantallas en ambos modos, sin desbordamiento horizontal del documento y con foco alcanzado por teclado. Campana añade fallo, recuperación, navegación y permisos. |

El [comentario inicial](https://github.com/voxtilabs/IAxTi/issues/588#issuecomment-6109928867) señala además la pérdida de una medición pagada si falla el GET posterior. Evaluaciones ahora usa la corrida completa que devuelve `POST /agents/:id/evaluate`, añade el resultado al historial y conserva la comparación sin ese GET redundante. Las respuestas tardías se descartan al cambiar negocio, sesión o asistente. Si falla el POST, conserva el historial y `code · requestId`. La regresión dirigida falla al reponer el refresco anterior y pasa con la respuesta guardada.

El vacío de Evaluaciones conserva la acción «Medir ahora». Dos activaciones mientras la petición está pendiente producen un solo POST y muestran «Midiendo…». Recordatorios conserva el enlace a Ajustes → Plantillas cuando no hay plantillas aprobadas.

## Alturas

Los cuatro saltos encontrados a 360 px eran reproducibles en día y noche. El marco estrecho reserva ahora la altura medida tanto para carga como para resultado. La tabla de auditoría mantiene su desplazamiento horizontal interno; el documento no desborda.

| Pantalla | Antes, carga → datos (px) | Después, carga → datos (px) | Después, carga → vacío (px) |
| --- | --- | --- | --- |
| Retención | 224 → 303 | 303 → 303 | No aplica: configuración |
| Recordatorios | 504,98 → 541,13 | 542 → 542 | 542 → 542 |
| Evaluaciones | 409,97 → 426,53 | 427 → 427 | 427 → 427 |
| Auditoría | 255 → 328 | 408 → 408 | 408 → 408 |
| Campana | No tenía esqueleto | 320 → 320 | 320 → 320 |

Auditoría necesitaba además reservar su vacío explicativo, que medía 407,78 px. Las medidas representan los casos tipados de la prueba: cinco entradas, dos corridas, una plantilla y tres avisos. No garantizan el alto de cualquier volumen o texto futuro; el E2E conserva esos casos como regresión.

## Capturas

Son recortes del componente real en Chromium, viewport CSS de 360 × 900, con contenido ficticio. No son datos de clientes. Las pruebas no ocultan elementos para capturar: en Evaluaciones se espera que caduque el aviso transitorio de los campos vecinos que guardan al perder el foco.

| Pantalla | Carga | Contenido | Vacío |
| --- | --- | --- | --- |
| Retención | [Día](retencion-dia-cargando-para-contenido.png) · [Noche](retencion-noche-cargando-para-contenido.png) | [Día](retencion-dia-contenido.png) · [Noche](retencion-noche-contenido.png) | No aplica |
| Recordatorios | [Día](recordatorios-dia-cargando-para-contenido.png) · [Noche](recordatorios-noche-cargando-para-contenido.png) | [Día](recordatorios-dia-contenido.png) · [Noche](recordatorios-noche-contenido.png) | [Día](recordatorios-dia-vacio.png) · [Noche](recordatorios-noche-vacio.png) |
| Evaluaciones | [Día](evaluaciones-dia-cargando-para-contenido.png) · [Noche](evaluaciones-noche-cargando-para-contenido.png) | [Día](evaluaciones-dia-contenido.png) · [Noche](evaluaciones-noche-contenido.png) | [Día](evaluaciones-dia-vacio.png) · [Noche](evaluaciones-noche-vacio.png) |
| Auditoría | [Día](auditoria-dia-cargando-para-contenido.png) · [Noche](auditoria-noche-cargando-para-contenido.png) | [Día](auditoria-dia-contenido.png) · [Noche](auditoria-noche-contenido.png) | [Día](auditoria-dia-vacio.png) · [Noche](auditoria-noche-vacio.png) |
| Campana | [Día](campana-dia-cargando-para-contenido.png) · [Noche](campana-noche-cargando-para-contenido.png) | [Día](campana-dia-contenido.png) · [Noche](campana-noche-contenido.png) | [Día](campana-dia-vacio.png) · [Noche](campana-noche-vacio.png) |

Errores de campana: carga [día](campana-dia-fallo-al-cargar.png) / [noche](campana-noche-fallo-al-cargar.png); marcado [día](campana-dia-fallo-al-marcar.png) / [noche](campana-noche-fallo-al-marcar.png).

## Validación y límites

- 7 pruebas DOM de Evaluaciones con hooks reales: respuesta pagada, comparación, doble activación, rastro del fallo y respuestas tardías tras cambiar negocio/sesión/asistente. El GET extra está preparado para fallar; la operación ya no lo requiere.
- 20 pruebas DOM de Campana/Arranque: permisos, rastro, recuperación, respuestas fuera de orden, cambios de negocio/sesión y teclado.
- 36 E2E aprobados: los 25 nuevos de `cinco-listas-medidas.spec.ts` y 11 existentes de `esqueletos-medidos.spec.ts`. La comprobación de Ctrl+clic exige otra pestaña con URL exacta al confirmar la navegación, y que la actual conserve su URL y el error. No exige readiness de Bandeja en la pestaña de fondo.
- Preflight con `web`, `ui` y `core`: 874 pruebas únicas aprobadas (381 core, 84 UI, 357 web y 52 DB), tipos 13/13, build 11/11, lint y guardas globales. Las diez pruebas omitidas en core son omisiones preexistentes.
- `/ui-check`: tokens y componentes compartidos, sin colores o efectos nuevos; foco y 360 px medidos. `/module-check`: sin contratos, manifiestos, endpoints ni dependencias nuevos; dependency-cruiser aprobado. `/security-review`: sin secretos ni datos reales; descarte de datos de otro contexto y permisos revocados cubierto en DOM; evidencia añadida a la fila de aislamiento de `COMPLIANCE_BASELINE.md`, sin afirmar garantías backend adicionales.

Comandos del repositorio, con Postgres/Redis locales de prueba configurados:

```sh
pnpm antes-de-empujar --filter=@iaxti/web --filter=@iaxti/ui --filter=@iaxti/core
pnpm --filter @iaxti/web e2e cinco-listas-medidas esqueletos-medidos
```

El arnés usa Auth/API/Next locales y datos sembrados; las respuestas de presentación y fallos se interceptan de forma explícita. Esta evidencia no acredita RLS del servidor, entrega a proveedores externos ni producción. No hay cambios de permisos backend, auditoría, migraciones o configuración productiva.

Se referencia [#588](https://github.com/voxtilabs/IAxTi/issues/588) sin cierre automático. El [comentario final](https://github.com/voxtilabs/IAxTi/issues/588#issuecomment-6178687521) deja pendiente la decisión sobre las otras entradas de consistencia de estilo. Aquí se conservan: no se toma esa decisión ni se rehacen esas pantallas.

El detector de esqueletos sigue midiendo por componente, no por cada rama de carga; la excepción manual de Bandeja conserva esa limitación explícita. El historial completo referido por la issue pertenece a #581 y no se declara resuelto por este cambio.
