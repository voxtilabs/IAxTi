# Paleta de IAxTi · azul, cian y mandarina

Definición de #408 y ADR-0022: una interfaz fresca, luminosa y cercana, con
el azul reconocible de IAxTi y la profundidad de Pulso Vivo. Se conserva la
composición existente; la personalidad cambia mediante color y material.

| Rol | Día | Noche | Uso |
| --- | --- | --- | --- |
| Azul IAxTi | `#3D5AFE` | `#3D5AFE` | Acción principal e isotipo; un primario por vista. |
| Cian luminoso | `#24D0E7` | `#24D0E7` | Reflejos del SVG y ambiente suave; nunca texto sobre blanco. |
| Mandarina | `#FFAB5E` | `#FFB66F` | Acento cálido y luz ambiental; presencia contenida. |
| Lienzo | `#EDF8FE` | `#0C1C30` | Fondo general, blanco azulado o azul profundo. |
| Superficie | `#FFFFFF` | `#16304D` | Tarjetas y formularios legibles. |
| Encabezado | `#F2FBFF` | `#173651` | Superficie ambiental de acceso y títulos. |
| Texto principal | `#102D44` | `#EFF8FF` | Titulares y datos, sin blanco puro sobre noche. |
| Texto secundario | `#4D677E` | `#ABC9E2` | Ayudas y metadatos visibles. |
| Enlaces | `#2553C6` | `#83C9FF` | Azul legible según superficie y modo. |
| Foco | `#2553C6` | `#83D7FF` | Anillo y borde de teclado; independiente del relleno. |

El resto de los pares de estados, campos y superficies está en
[`pulso-tokens.css`](../../packages/ui/pulso-tokens.css). Los componentes
consumen roles semánticos; no duplican estos valores.

## Reglas de uso

- Predominan las superficies: el azul dirige la acción y cian/mandarina
  acompañan la marca. No se colorean párrafos ni filas completas por decoración.
- Día: paneles blancos y lienzo ligeramente cian. Noche: superficies azules
  distinguibles, con menor peso de sombras y reflejos más claros.
- Éxito permanece verde; advertencia ámbar; error rosa/rojo. Color acompañado
  por texto o icono, sin reutilizar estados como decoración de marca.
- Sin cambiar familias tipográficas, tamaños, espacios, SVG, navegación ni
  comportamiento. El login conserva su adaptación por ancho y altura.
- Hover, foco, texto secundario y placeholder son parte de la paleta y de
  las pruebas, no excepciones a revisar después.

## Legibilidad

Las pruebas usan al menos 4,5:1 para texto normal y 3:1 para foco/bordes de
campo. Esos umbrales proceden de [contraste de texto del W3C](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
y [contraste de componentes del W3C](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
Esto verifica los pares definidos; no es una certificación de accesibilidad
de todos los estados posibles del producto.

La fuente verificable es `packages/ui/tests/contraste.test.ts`; la revisión
visual y sus capturas se documentan en `design-qa.md` y `docs/evidencias/408/`.
