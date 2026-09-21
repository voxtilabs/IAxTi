# ADR 0022 · Colorimetría fresca y foco independiente

**Estado:** aceptada por instrucción del usuario · 2026-09-21 · #408

## Contexto

El usuario pide definir y publicar una paleta más fresca y menos opaca sin
romper el diseño de IAxTi. Las superficies de Pulso Vivo tienen un matiz
grisáceo y el modo noche se acerca al negro. Iluminarlas sin revisar el foco
reduce el contraste del azul de acción usado también como anillo.

## Decisión

Conservar el azul de marca y su uso como única acción principal. Sustituir
los grises por blancos azulados en día y azules profundos en noche, con cian
en ambiente/material y mandarina en el acento cálido. La definición por rol
y sus valores viven en `docs/diseno/paleta.md` y `packages/ui/pulso-tokens.css`.

Introducir `--focus`, independiente de `--action`, para mantener el foco
visible sobre superficies más luminosas. Outline, borde enfocado y rings de
shadcn consumen el mismo token. No cambia el grosor, orden o manejo del foco.
El hover primario también debe conservar contraste de texto normal.

Se actualizan los valores cromáticos heredados de ADR-0009, manteniendo las
decisiones de composición/material de ADR-0021. Continúan la geometría del
SVG, las tipografías, radios, espaciado, responsividad y funciones existentes.
El verde es éxito, el ámbar advertencia y el rosa/rojo error, siempre con texto.

## Consecuencias y verificación

Web, admin y webchat reciben la paleta desde la capa común. Los colores
decorativos no se usan como texto ni como una segunda acción principal.
Se amplían las guardas de contraste para hover, placeholders y superficies
de foco, se verifican los formularios existentes y se comparan capturas en
ambos modos. Ninguna pantalla define una paleta propia.
