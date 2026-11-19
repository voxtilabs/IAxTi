# ADR-0035 · El tablero se mueve con dnd-kit

- **Estado:** aceptada
- **Fecha:** 2026-11-19
- **Issues:** #1367, apoyada en #1301; reemplaza la mecánica de #33

## Contexto

Mover una oportunidad entre etapas tenía una sola entrada: el arrastre HTML5
nativo (`draggable` + `dataTransfer`). Ese arrastre no existe con el dedo —
los eventos drag de HTML5 no se disparan con táctil — y en un producto
WhatsApp-primero el tablero se entra desde 360 px **por diseño** (#33). La
acción central del CRM estaba muerta en el bolsillo, y sin camino de teclado,
muerta también para quien no usa ratón (#1301 había corregido lo mismo para
ABRIR).

El arreglo a mano era la peor parte: reimplementar táctil sobre `dataTransfer`
es reconstruir, pieza por pieza, lo que una librería de arrastre ya es —
sensores, medición de geometría, detección de colisión, anuncios de lector de
pantalla—. El propio dueño lo puso así: no más código complicado y peor que el
que ya existe.

## La decisión

`@dnd-kit/core` en `apps/web` para el arrastre del tablero, y la ficha gana
un selector de etapa. Nada del backend cambia: mismo `POST /deals/:id/stage`,
mismos diálogos de motivo al retroceder y al perder.

- **`PointerSensor`** unifica ratón y dedo; **`KeyboardSensor`** levanta con
  Espacio y cruza con flechas. El anuncio al lector de pantalla va en la voz
  del producto (`accessibility.announcements`), no en la de la librería.
- **`useDroppable` + `isOver`** marca la columna de destino mientras flota:
  la señal que el `dataTransfer` nunca dio.
- **El selector en la ficha** usa el MISMO diálogo de motivo que el arrastre:
  un solo camino para retroceder y para perder, venga del gesto o del
  selector. Es el camino de quien no arrastra — y el respaldo del de teclado.

## Por qué una dependencia y no a mano

La alternativa seria no era el `dataTransfer` viejo: era escribir sensores
propios. La cuenta da lo mismo en cualquier orden: capturar puntero Y táctil,
resolver la colisión contra columnas que se desplazan, devolver el foco, y
anunciar el movimiento en español a un lector de pantalla. `dnd-kit` trae las
cuatro piezas y las apaga bien cuando se cancela; el código propio las
reimplementaría peor y sin quien las mantenga. Las librerías de arrastre
vivibles que quedan son dnd-kit y nada — `react-beautiful-dnd` está
abandonada desde 2022.

La dependencia es del frontend, de un paquete que solo el tablero importa, y
se fue a `package.json` de `apps/web`: el monolito modular no la ve.

## Lo que esto NO resuelve, dicho para que nadie lo suponga

- **Reordenar dentro de una etapa no existe.** `moveDealStage` es
  cross-stage; si se pide, es otro issue con su API antes que su UI.
- **El arrastre no crea oportunidades ni las edita.** Mueve de etapa, nada
  más, y el guard de permisos es el mismo de siempre: sin
  `crm.deals.update` el selector no aparece y el arrastre no parte.
- **jsdom no tiene táctil.** La prueba de comportamiento ejercita el sensor
  de teclado, que por dentro recorre el mismo camino —sensores, medición,
  colisión, `onDragEnd`— que el dedo. El táctil quedó verificado a mano en
  360 px, no simulado.
