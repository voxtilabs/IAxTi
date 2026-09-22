# Bandeja sin desplazamiento hacia un fondo vacío · #429

## Reproducción y causa

En staging `8cbf762`, entrar a Bandeja con 50 conversaciones, mover la rueda
fuera de los paneles o llevar la barra del navegador al final: el contenido
desaparece hacia arriba y queda el fondo. A 1366×768, el documento mide
3.288 px sin soporte activo y 3.326 px con soporte. Con tres conversaciones
no sucede: esa fue la diferencia que aisló la reproducción.

El `sr-only` de `CanalChip` tiene posición absoluta, pero no tenía un
contenedor posicionado dentro de la fila. Sus cajas se referían al `main`
exterior y escapaban del recorte de la lista desplazable. Se conserva el
nombre accesible y se contiene dentro del propio chip con `position: relative`.

Había dos problemas adicionales: el cálculo `100vh - 73px` no descontaba el
aviso de soporte; en 360 px el encabezado solapaba la identidad con los
botones. En 768 px, tres paneles simultáneos dejaban el chat estrechísimo y
el documento medía 832 px de ancho.

## Resultado

- El shell de Bandeja reparte `100dvh` entre soporte, cabecera y contenido
  flexible, con mínimos que permiten reducir los paneles. Las otras rutas
  conservan su documento desplazable. Se elimina el `main` anidado.
- Lista, mensajes y ficha tienen su propio scroll y contención. El
  autoscroll de mensajes solo desplaza el historial, sin mover sus ancestros.
- Búsqueda y cabeceras no se comprimen. Identidad y acciones del chat pueden
  ocupar filas distintas. Bajo 1024 px se usa la navegación existente
  lista → chat → ficha; desde 1024 px se mantienen los tres paneles.
- No cambian endpoints, permisos, canales, datos ni reglas de respuesta.

## Evidencia visual

Assets anteriores capturados en staging; resultado en build de producción
local. En ambos, sesión y contenido son sintéticos e interceptados solo en
el navegador: **no son conversaciones de clientes**. Playwright Chromium,
movimiento reducido, viewports CSS y estados iguales en cada comparación.

| Caso | Comparación conjunta | Originales |
| --- | --- | --- |
| Escritorio, noche, barra del navegador al final | [Antes/después](escritorio-noche-comparacion.png) | [Antes](escritorio-noche-antes.png) · [Después](escritorio-noche-despues.png) |
| Móvil 360×640, chat diurno | [Antes/después](movil-dia-comparacion.png) | [Antes](movil-dia-antes.png) · [Después](movil-dia-despues.png) |
| Tablet 768×768, chat diurno | [Antes/después](tablet-dia-comparacion.png) | [Antes](tablet-dia-antes.png) · [Después](tablet-dia-despues.png) |

Medidas: [antes.json](antes.json) y [despues.json](despues.json). La captura
`resized` espera un frame del navegador para medir el nuevo viewport; la
medición definitiva de cada cambio de altura es `resized-bottom`.

## Validación

La nueva regresión falló contra el build anterior en escritorio y móvil:
`documentoAjustado` detectó miles de píxeles adicionales, mientras los 65
E2E anteriores pasaron. La prueba final cubre 1366×768, 768×768 y 360×640,
50 conversaciones y 80 mensajes, rueda hasta ambos extremos, respuesta
visible, soporte activo/inactivo, ficha, reducción de altura, teclado,
overlay y salida a Reportes con scroll normal.

La sesión y los permisos de esos E2E pasan por la API/Postgres/Redis locales
reales; únicamente el volumen de mensajes/lista y el estado de soporte se
interceptan para hacer determinista el escenario. El E2E existente de
Bandeja sigue asignando, respondiendo y resolviendo por la API real y el
canal simulado. No prueba entregas con proveedores externos.

Resultados locales: build 30/30, typecheck 54/54, lint, dependency-cruiser
(632 módulos, 1.435 dependencias), UI 49/49 y E2E **68 aprobados**; cinco
capturas opcionales omitidas por configuración. Sin errores JavaScript en
las 52 observaciones visuales finales. CI y despliegue se registran en el PR.

`/ui-check`: mismos tokens, foco y controles; sin colores/efectos locales ni
cambios según modo. `/module-check`: sin contratos ni manifiestos alterados.
SPEC §29 documenta la distribución; no hay decisión arquitectónica nueva.
