---
description: Verifica que la UI del diff cumple Mesón (ADR-0034)
---

Sobre los archivos de UI del diff actual (o `$ARGUMENTS`), contra
`.claude/rules/ui-meson.md`:

1. Grep de antipatrones: hex sueltos (`#[0-9a-fA-F]{3,8}` fuera de
   pulso-tokens.css), `dark:`, `box-shadow`/`shadow-` (salvo `shadow-flotante`
   en lo que flota), `gradient`, emoji en JSX, `purple`/`violet`, `uppercase`
   con `tracking-`, `font-bold`/`font-extrabold`, `transition-all`,
   `animate-pulse` en algo que no está vivo.
2. ¿Un solo botón primario (azul VoxTi) por vista? ¿El azul solo marca acción,
   selección o la cifra que importa, y no decora el marco? ¿Radios 8 control /
   12 tarjeta / 16 panel, anidados que suman? ¿Algo en forma de píldora? (mal)
3. ¿Instrument Sans en 400/500 y jerarquía por tamaño y color? ¿Montos, UF, RUT,
   teléfonos, fechas, horas e ids en JetBrains Mono? ¿Mono en prosa? (mal)
4. ¿Etiquetas con `--{rol}-soft`/`--{rol}-text`? ¿Algún estado donde el color
   sea el único significado?
5. Copy: ¿avisos dicen qué pasó y qué hacer? ¿Estados vacíos dicen qué va a
   aparecer y la acción? ¿Sin «!», sin «…» en placeholders, sin punto final en
   rótulos? ¿Español de Chile, tuteo?
6. ¿Foco visible? ¿Funciona a 360 px sin scroll horizontal? ¿Controles de 44 px
   en celular? ¿prefers-reduced-motion respetado?
7. ¿El componente conoce el modo? (mal: debe salir todo de los tokens)

El isotipo `MarcaJelly` se queda igual (decisión de Lino): comprobar IDs únicos y
uso decorativo. La boleta del asistente usa `--paper*` y es el único lugar
cálido; el reloj de la ventana de 24 h es la firma y no se repite en otros lados.

Reporta por archivo con la corrección concreta. Recuerda al autor las capturas
en día y noche para el PR.
