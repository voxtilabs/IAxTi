---
description: Crea un ADR numerado en docs/adr/ con el formato del proyecto
---

Crea el ADR para: $ARGUMENTS

1. Mira `docs/adr/` y toma el siguiente número correlativo (formato
   `NNNN-slug.md`).
2. Formato: título `# ADR NNNN · <decisión>`, `**Estado:** propuesta ·
   <fecha>`, secciones `## Contexto` (el problema, sin la solución), `##
   Decisión` (qué se decide, concreto), `## Consecuencias` (lo que ganamos y
   lo que renunciamos), `## Se revisa cuando` (condición observable, no
   fecha).
3. Si el ADR contradice uno anterior, el nuevo lo dice explícitamente
   ("reemplaza a ADR-XXXX en ...") y el viejo se marca `superseded`.
4. Corto: un ADR que no cabe en una pantalla está contando la implementación,
   no la decisión.
