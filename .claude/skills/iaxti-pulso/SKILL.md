---
name: iaxti-pulso
description: Aplicar el sistema de diseño Pulso en IAxTi. Usar al crear o modificar cualquier pantalla, componente, o al tematizar shadcn.
---

# Pulso en IAxTi

Regla completa en `.claude/rules/ui-pulso.md` y ADR-0009. Esta skill es el
"cómo se hace".

## Setup (ya decidido, no reabrir)

- `packages/ui/pulso-tokens.css`: dos bloques de tokens (día y noche).
  Se importa UNA vez en cada app.
- Modo: `<html data-mode="dia|noche">`; inicial por `prefers-color-scheme`;
  el toggle persiste por usuario. Tailwind: colores → variables;
  `darkMode: ['selector', '[data-mode="noche"]']`.
- shadcn se tematiza en `packages/ui`, no en cada app: botón radio 999, campo
  14, tarjeta 22, control 46 px, Outfit/Inter/JetBrains Mono.

- Pulso Vivo (ADR-0021): `pulso-vivo.css` aplica material jelly, relieves y
  ambiente desde tokens compartidos. No agregar efectos locales.

## Cómo escribir un componente

1. Colores solo por token (`bg-raised`, `text-muted`, `border-line`...). Si
   necesitas un color que no existe, el token se agrega a pulso-tokens.css en
   PR propio — nunca un hex local.
2. El componente no sabe el modo: nada de `dark:`, nada de leer `data-mode`.
3. Números que son datos (montos, UF, RUT, fechas, plazos, ids) → mono.
4. Un botón primario por vista; el resto secundarios o ghost.
5. Estados: etiqueta con `--{rol}-soft` + `--{rol}-text` + texto o ícono que
   acompañe al color.
6. Textos: qué pasó y qué hacer. Español de Chile, tuteo, sin jerga.

## Patrones del producto

Bandeja 3 paneles (raised·bg·raised, apilados en celular) · sugerencia IA en
aviso `action-soft` con primario "Enviar sugerencia" · acciones de IA como
filas con rótulo mono ("AGENDÓ") · ventana 24 h como etiqueta warn (<2 h) /
bad (cerrada) · costos siempre visibles en mono · configurador con el
dispositivo antes/después.

Antes del PR: `/ui-check` + capturas día y noche + prueba a 360 px.
