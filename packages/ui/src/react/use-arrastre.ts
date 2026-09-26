'use client';

import { useCallback, useRef, useState, type DragEvent, type ClipboardEvent } from 'react';

/**
 * Arrastrar un archivo y pegarlo desde el portapapeles (#561).
 *
 * La forma viene del bloque `file-upload-04` de blocks.so (MIT,
 * github.com/ephraimduncan/blocks). Lo que se conserva es el gesto; lo que se
 * separó acá es el COMPORTAMIENTO, porque el bloque lo tiene mezclado con su
 * recuadro punteado y IAxTi lo necesita de dos formas distintas: un recuadro
 * fijo en la pantalla de conocimiento, y un aviso que aparece encima del chat
 * en la bandeja. Un componente que sirviera a las dos terminaría con un `modo`
 * y dos ramas; un hook sirve a las dos sin decidir cómo se ven.
 *
 * Lo que el bloque NO resuelve y acá sí:
 *
 * 1. **`dragleave` dispara al entrar a un hijo.** Arrastrar sobre el recuadro y
 *    pasar por encima de un texto adentro apaga el resaltado, así que parpadea.
 *    Se cuenta cuántas veces se entró y se salió en vez de mirar un booleano.
 * 2. **Pegar.** El bloque no lo tiene, y es el gesto más usado de los dos:
 *    una captura se pega, no se guarda en disco para después buscarla.
 * 3. **Pegar texto sigue siendo pegar texto.** Solo se intercepta si el
 *    portapapeles trae un archivo; si no, se deja pasar. Romper Ctrl+V en un
 *    campo de mensajes sería un arreglo peor que el problema.
 */
export interface Arrastre {
  /** Si hay algo encima ahora mismo: para resaltar o mostrar el aviso. */
  arrastrando: boolean;
  /** Se esparcen en el elemento que recibe: `<div {...arrastre.props}>`. */
  props: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  /** Para el campo de texto: `<Textarea onPaste={arrastre.alPegar} />`. */
  alPegar: (e: ClipboardEvent) => void;
}

export interface OpcionesDeArrastre {
  /** Qué hacer con el archivo. Uno solo: es lo que la API acepta por mensaje. */
  alRecibir: (archivo: File) => void;
  /**
   * Cuando está apagado no se acepta nada y no se resalta nada. Existe para la
   * ventana de 24 h: fuera de ella solo salen plantillas, y ofrecer que
   * sueltes una foto que no va a salir es mentir.
   */
  activo?: boolean;
}

export function useArrastre({ alRecibir, activo = true }: OpcionesDeArrastre): Arrastre {
  const [arrastrando, setArrastrando] = useState(false);
  /**
   * Cuántas veces se entró menos cuántas se salió. Un booleano no alcanza:
   * `dragenter` del hijo llega ANTES del `dragleave` del padre, así que con un
   * booleano el resaltado se apaga al pasar sobre cualquier cosa de adentro.
   */
  const dentro = useRef(0);

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      if (!activo) return;
      // Solo cuenta si lo que viene es un archivo. Arrastrar texto seleccionado
      // de la misma página no es adjuntar nada.
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      dentro.current += 1;
      setArrastrando(true);
    },
    [activo],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (!activo) return;
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      // Sin esto el navegador ABRE el archivo y se pierde la conversación.
      e.preventDefault();
    },
    [activo],
  );

  const onDragLeave = useCallback((e: DragEvent) => {
    if (dentro.current === 0) return;
    e.preventDefault();
    dentro.current -= 1;
    if (dentro.current === 0) setArrastrando(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!activo) return;
      e.preventDefault();
      dentro.current = 0;
      setArrastrando(false);
      const archivo = e.dataTransfer.files?.[0];
      // Uno solo, y el primero: la API acepta un adjunto por mensaje, y
      // quedarse callado con los otros cuatro sería perderlos en silencio. De
      // avisarlo se encarga quien usa el hook, que es quien tiene la pantalla.
      if (archivo) alRecibir(archivo);
    },
    [activo, alRecibir],
  );

  const alPegar = useCallback(
    (e: ClipboardEvent) => {
      if (!activo) return;
      const archivos = Array.from(e.clipboardData?.files ?? []);
      // Si no viene un archivo, esto no se entromete: pegar texto tiene que
      // seguir funcionando igual en un campo de mensajes.
      if (archivos.length === 0) return;
      e.preventDefault();
      alRecibir(archivos[0]!);
    },
    [activo, alRecibir],
  );

  return { arrastrando, props: { onDragEnter, onDragOver, onDragLeave, onDrop }, alPegar };
}
