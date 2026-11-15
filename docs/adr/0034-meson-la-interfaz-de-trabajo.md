# ADR 0034 · Mesón: la interfaz de trabajo de IAxTi

**Estado:** aceptada por Lino · 2026-11-14 · reemplaza a la
[ADR-0021](0021-pulso-vivo-identidad-y-profundidad.md) (Pulso Vivo) y al resto
de la [ADR-0009](0009-pulso-como-sistema-de-diseno.md) que seguía en pie. La
[ADR-0022](0022-colorimetria-fresca-y-foco.md) sigue valiendo en lo que dice del
**foco**; sus valores de color, no.

> **Decidido por Lino el 14-11:** «todavía no llegamos a la UI necesaria,
> olvídate de PULSO». Vio el prototipo Mesón y lo aprobó, con una corrección:
> el acento es **el azul de VoxTi**, no el naranja que traía el prototipo
> («debes usar los colores de voxtilabs»). El isotipo jelly **se queda igual**.

## Contexto

El 12-11 se hizo una pasada de pulido (#1344) que respetó Pulso a pedido. Dejó
la app correcta pero genérica: tres tarjetas por pantalla, todo con el mismo
peso, el azul repartido en el marco. Pulso hacía bien lo que pide un sistema
—tokens, día y noche, contraste medido— y mal lo que pide un producto: que la
pantalla diga **para qué es**.

El 03-06-2026 Meta lanzó Meta Business Agent para todos los países: un bot de
atención dentro de WhatsApp, gratis en el plan de entrada. «Ponle un bot a tu
WhatsApp» dejó de ser algo que IAxTi pueda vender. Lo que Meta no tiene es lo
de alrededor: el embudo, la agenda, el equipo atendiendo un mismo número, la
ventana de 24 h, los costos. La interfaz tiene que mostrar ESO primero.

## Decisión

Una dirección propia, **Mesón**, derivada del producto y no de una tendencia:

- **Mundo:** el mesón de una pyme chilena — la libreta de pedidos, las
  boletas, el celular al lado y el lápiz pasta azul con que se anota todo.
- **Carácter:** conversado, al día, de confianza.
- **Marco quieto:** grises casi neutros con un toque cálido apenas visible
  (`#FAF9F7` / `#161513`). La barra lateral es un escalón hundido, pegada al
  borde, no una tarjeta flotante. Nada brilla, nada tiene ambiente degradado.
- **Un acento:** el azul de VoxTi `#3D5AFE`, el del isotipo, igual en los dos
  modos. Marca el botón principal, la selección, lo no leído y la cifra que
  importa. Como tinta se oscurece de día (`#3349E8`) y se aclara de noche
  (`#8C9BFF`).
- **Letra:** Instrument Sans para todo, en 400 y 500 (600 a lo más);
  JetBrains Mono para montos, RUT, teléfonos, horas e ids. La jerarquía la da
  el tamaño y el color, no el grosor. Base de 14 px.
- **Medidas:** controles de 36–40 px (44 en celular), radios 8 / 12 / 16
  — control / tarjeta / panel —, anidados que suman. Nada es píldora.
- **El momento:** la **boleta del asistente** en la ficha del cliente — papel
  (`--paper*`), mono, lo que hizo, lo que queda por cobrar y un timbre. Es la
  forma en que el bot deja de ser «un bot» y pasa a ser alguien que deja
  comprobante. En Oportunidades, el momento es la cifra que Meta no puede
  mostrar: cuánto cerró el asistente solo.
- **La firma:** el reloj de la ventana de 24 h en mono — gris abierta, ámbar a
  menos de 2 h, rojo solo dentro del chat cuando ya no deja escribir.

Prototipo y capturas: `docs/diseno/meson/`.

## Lo que NO cambia

No es estética, es calidad, y sigue siendo regla: foco visible (ADR-0022),
360 px sin scroll horizontal, día y noche por `data-mode` sin `dark:`, hex solo
en `pulso-tokens.css`, mono para montos/RUT/fechas, sin emoji, contraste AA
medido por `packages/ui/tests/contraste.test.ts`, voz de Chile con tuteo.

## Cómo se aplica

1. **Tokens primero** (este PR): mismos NOMBRES, valores nuevos. Lo que Pulso
   Vivo pintaba —ambiente, relieves, sombras azules del botón— queda
   transparente o en una sombra neutra chica, así que desaparece de las 62
   pantallas sin tocarlas. Retirar los nombres viejos es mecánico y va aparte.
2. **Una pantalla por PR**, con capturas día y noche: Bandeja, Contactos,
   Oportunidades, y después el resto.
3. Los nombres de archivo `pulso-*.css` se quedan por ahora: renombrarlos toca
   cada import sin cambiar nada que se vea.

## Consecuencias

- Pantallas que dependían de la píldora o del jelly decorativo (vacíos, acceso)
  se ven planas hasta que les toque su PR. Es aceptable: planas no es rotas.
- La skill `iaxti-pulso`, el agente `reviewer-pulso` y `/ui-check` describen
  Pulso; se actualizan para apuntar a `.claude/rules/ui-meson.md`.
- Crédito: la dirección salió de una pasada con la skill unslop de Damir
  Sokolovsky (@heydamir), CC BY 4.0.
