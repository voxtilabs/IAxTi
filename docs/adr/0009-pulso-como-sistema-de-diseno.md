# ADR 0009 · Pulso como sistema de diseño

**Estado:** superseded parcialmente por ADR-0021 · decisión original aceptada · 2026-09-13

## Contexto
La interfaz la produce mayormente Claude Code; sin un sistema cerrado, cada
pantalla inventa colores, radios y sombras y el producto se ve improvisado.

## Decisión
El sistema Pulso de VoxTi Labs, tal cual su documento. Tokens día/noche en
`packages/ui/pulso-tokens.css`; modo con `<html data-mode="dia|noche">` inicial
por `prefers-color-scheme`, persistido por usuario. Tailwind apunta a variables;
nunca `dark:` en componentes. shadcn tematizado: botón 999, campo 14, tarjeta
22, control 46 px, sin sombras, Outfit / Inter / JetBrains Mono. Tres
superficies, un primario por vista, mono para montos/UF/RUT/fechas/ids, foco
visible, 360 px sin scroll horizontal.

## Consecuencias
- Ningún hex suelto en componentes (check en CI y en `/ui-check`).
- Antipatrones prohibidos sin excepción: gradientes, sombras, morado/violeta,
  verde principal, blanco puro nocturno, negro puro, glassmorphism, emoji en
  interfaz, iconos de cohete/rayo/cerebro, contadores animados, métricas
  inventadas.
- IAxTi sin logo por ahora: nombre en Outfit 800 como texto. Lockup VoxTi Labs
  en SuperAdmin y pie de la app.

## Se revisa cuando
Pulso publique nueva versión; se adopta por PR que actualice los tokens.
