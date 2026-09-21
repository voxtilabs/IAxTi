# Regla: interfaz (sistema Pulso)

- Tokens en `packages/ui/pulso-tokens.css` (bloques día y noche). Modo con
  `<html data-mode="dia|noche">`; inicial por `prefers-color-scheme`;
  persistido por usuario. Tailwind apunta a variables (`bg`, `raised`, `rest`,
  `line`, `ink`, `body`, `muted`, `action`). NUNCA variantes `dark:` en
  componentes; ningún componente sabe en qué modo está.
- Ningún hex suelto en componentes. Las superficies base y las de Pulso Vivo
  (ADR-0021) se definen en esos tokens, junto con material y profundidad.
- shadcn tematizado: radios botón 999 / campo 14 / tarjeta 22; controles
  46 px; Outfit (solo titulares) / Inter (prosa) / JetBrains Mono
  (montos, UF, RUT, fechas, plazos, identificadores — y mono nunca en prosa).
- Un solo botón primario por vista. Etiquetas: fondo `--{rol}-soft`, texto
  `--{rol}-text`; el color nunca es el único portador de significado.
- Avisos: qué pasó y qué hacer, en una frase. Estados vacíos: qué va a
  aparecer y la acción que lo provoca. Español de Chile, tuteo, sin jerga.
- Foco visible: `outline: 2px solid var(--focus); outline-offset: 2px`.
  ADR-0022 separa el foco del relleno de acción para mantener contraste al
  iluminar las superficies nocturnas. Rings shadcn apuntan al mismo token.
  Funciona a 360 px sin scroll horizontal. Respeta `prefers-reduced-motion`.
- Producto: bandeja de tres paneles (lista raised · chat bg · ficha raised;
  apiladas en celular). Sugerencia del copiloto en aviso `action-soft` sobre
  el campo, primario "Enviar sugerencia". Acciones de IA en la ficha con
  rótulo mono ("AGENDÓ", "ENVIÓ LINK"). Ventana de 24 h como etiqueta `warn`
  a < 2 h y `bad` cerrada. Costos siempre visibles, en mono.
- Pulso Vivo (ADR-0021): material jelly del isotipo propio, relieves y
  ambiente estático en `pulso-vivo.css`, con valores en `pulso-tokens.css`.
  Overlays conservan `shadow-flotante`. Sin sombras/gradientes arbitrarios en
  componentes, sin WebGL ni animación continua, contraste y movimiento reducido.
- Antipatrones: morado/violeta, verde como
  principal, blanco puro en texto nocturno, negro puro de fondo,
  glassmorphism, emoji en interfaz, iconos de cohete/rayo/cerebro, contadores
  animados, copy de relleno, métricas inventadas.
- Marca: lockup VoxTi Labs inline en SuperAdmin y pie de la app. IAxTi con su isotipo oficial y
  nombre en Outfit; el SVG jelly es decorativo y no agrega funciones.
- Antes del PR con UI: `/ui-check` y capturas en día y noche.
