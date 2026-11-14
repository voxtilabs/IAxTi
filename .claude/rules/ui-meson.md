# Regla: interfaz (dirección Mesón, ADR-0034)

Reemplaza a Pulso / Pulso Vivo (ADR-0009, ADR-0021). Mundo: el mesón de una
pyme — libreta, boletas, el celular al lado y el lápiz pasta azul. El marco es
quieto; el color lo pone el contenido.

- Tokens en `packages/ui/pulso-tokens.css` (el nombre del archivo se quedó; el
  contenido es Mesón). Modo con `<html data-mode="dia|noche">`; inicial por
  `prefers-color-scheme`; persistido por usuario. Tailwind apunta a variables
  (`bg`, `raised`, `rest`, `line`, `ink`, `body`, `muted`, `action`). NUNCA
  variantes `dark:`; ningún componente sabe en qué modo está.
- Ningún hex suelto fuera de ese archivo. Sin sombras ni degradados propios en
  componentes: profundidad = escalón de superficie + filete; los que flotan
  usan `shadow-flotante`.
- **Acento único: el azul de VoxTi `#3D5AFE`** (`action`), igual en día y
  noche. Marca el botón principal, la selección, lo no leído y la cifra que
  importa — no decora el marco. Un solo botón primario por vista.
- **Superficies:** `bg` página (`#FAF9F7`/`#161513`), `raised` tarjeta,
  `rest` fila activa/campo/burbuja propia, `chrome` la barra lateral (un
  escalón hundido, pegada al borde). Grises casi neutros con toque cálido; si
  un fondo se lee como «azul» o «café», se pasó.
- **Letra:** Instrument Sans en 400/500 (600 a lo más), jerarquía por tamaño y
  color, base 14 px, minúscula de oración, sin versales espaciadas, sin
  tracking negativo bajo 24 px. JetBrains Mono para montos, UF, RUT, teléfonos,
  fechas, horas e ids — nunca en prosa. Cifras con `tabular-nums`.
- **Medidas:** controles 36–40 px (44 en celular), filas de navegación 36,
  radios 8 control / 12 tarjeta / 16 panel, anidados que suman (interior =
  exterior − relleno). Nada es píldora. Escala de 4 px.
- **Iconos:** lucide, 16 px, trazo 1,5, color del texto apagado. El activo
  lleva el azul en el icono, no en el texto. Sin destellos/cohete/rayo/cerebro.
- **El momento:** la boleta del asistente en la ficha (`--paper*`, mono): lo
  que hizo, lo que queda por cobrar, un timbre. Es el único lugar cálido de la
  pantalla. **La firma:** el reloj de la ventana de 24 h en mono — apagado
  abierta, `warn` a < 2 h, `bad` solo dentro del chat cuando ya no deja
  escribir. No repetirla en otros lados.
- Producto: bandeja de tres paneles (lista · chat · ficha; apiladas en
  celular). Sugerencia del copiloto en `action-soft` sobre el campo. Costos
  siempre visibles, en mono.
- Etiquetas: fondo `--{rol}-soft`, texto `--{rol}-text`; el color nunca es el
  único portador de significado.
- Copy: avisos dicen qué pasó y qué hacer, en una frase; estados vacíos dicen
  qué va a aparecer y la acción que lo provoca. Sin signos de exclamación, sin
  «…» en placeholders, sin punto final en rótulos. Español de Chile, tuteo.
- Foco visible: `outline: 2px solid var(--focus); outline-offset: 2px`
  (ADR-0022). 360 px sin scroll horizontal. Respeta `prefers-reduced-motion`;
  movimiento solo de color/opacidad/transform, una curva, nada en bucle.
- Antipatrones: morado/violeta, degradados de tono, texto degradado, brillos,
  glassmorphism, emoji, versales espaciadas, métricas inventadas, copy de
  relleno, contadores animados.
- Marca: el isotipo jelly de IAxTi **se queda igual** (decisión de Lino) y es
  lo único brillante del marco; el nombre IAxTi en Instrument Sans 600. Lockup
  VoxTi Labs en SuperAdmin, login e invitación; en la barra de la app solo la
  firma en texto apagado (#1157).
- Antes del PR con UI: `/ui-check` y capturas en día y noche.
