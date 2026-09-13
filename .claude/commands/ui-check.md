---
description: Verifica que la UI del diff cumple Pulso
---

Sobre los archivos de UI del diff actual (o `$ARGUMENTS`):

1. Grep de antipatrones: hex sueltos (`#[0-9a-fA-F]{3,8}` fuera de
   pulso-tokens.css), `dark:`, `box-shadow`/`shadow-`, `gradient`, emoji en
   JSX, `purple`/`violet`.
2. ¿Un solo botón primario por vista? ¿Controles de 46 px? ¿Radios correctos
   (botón 999, campo 14, tarjeta 22)?
3. ¿Montos, UF, RUT, fechas, plazos e ids en JetBrains Mono? ¿Outfit solo en
   titulares? ¿Mono en prosa? (mal)
4. ¿Etiquetas con `--{rol}-soft`/`--{rol}-text`? ¿Algún estado donde el color
   sea el único significado?
5. ¿Avisos dicen qué pasó y qué hacer? ¿Estados vacíos dicen qué va a aparecer
   y la acción? ¿Español de Chile, tuteo?
6. ¿Foco visible? ¿Funciona a 360 px sin scroll horizontal?
   ¿prefers-reduced-motion respetado?
7. ¿El componente conoce el modo? (mal: debe salir todo de los tokens)

Reporta por archivo con la corrección concreta. Recuerda al autor las capturas
en día y noche para el PR.
