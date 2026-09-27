'use client';

import { useEffect, useId, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';

export { toast } from 'sonner';

/**
 * Cómo se ven los avisos (#650).
 *
 * Lo que había se veía mal por tres cosas concretas, medidas en pantalla:
 *
 * 1. **El botón de cerrar era un círculo de 46 px a la IZQUIERDA.** Con
 *    `unstyled` el botón es un hijo más del flex y va primero en el DOM, así que
 *    el orden de lectura era «círculo blanco vacío, ícono, texto». Y encima
 *    `bg-field` lo pintaba blanco sobre el rosado del error: un agujero en el
 *    medio del aviso, más grande que el mensaje.
 *
 *    El 46 px venía de `min-h-control`, que es la medida de un CONTROL de
 *    formulario —pensada para que el dedo acierte—. Para cerrar un aviso que ya
 *    se va solo a los 6 s, eso es una pieza de chapa donde va un gesto. Se
 *    conserva el área de toque (44 px) y se le saca el cuerpo: sin borde, sin
 *    relleno, el aspa en `text-muted` hasta que el cursor encima la enciende.
 *
 * 2. **No tenía sombra.** `ui-pulso.md` pide `shadow-flotante` en los overlays,
 *    y un aviso es exactamente eso. Sin ella no flotaba: parecía pegado al
 *    contenido, y flotar es lo que le dice a alguien que esto es pasajero.
 *
 * 3. **El ícono se centraba con todo el bloque.** Con una sola línea daba igual;
 *    con dos, quedaba flotando al medio en vez de al lado de la primera. Ahora
 *    se alinea arriba y se achica al tamaño del texto.
 */
export function Avisos() {
  return <Toaster containerAriaLabel="Avisos de resultado" position="bottom-right" closeButton duration={6000} gap={12} toastOptions={{
    unstyled: true,
    closeButtonAriaLabel: 'Cerrar aviso',
    classNames: {
      // `items-start` y no `items-center`: el ícono acompaña a la PRIMERA línea.
      toast: 'pulso-aviso flex w-full items-start gap-3 rounded-campo border border-line-strong bg-raised p-4 pr-2 font-body text-dato text-ink shadow-flotante',
      content: 'flex min-w-0 flex-1 flex-col gap-1 py-1',
      icon: 'mt-1 flex shrink-0 items-center [&>svg]:size-4',
      description: 'text-body', title: 'font-medium',
      success: '!border-good-soft-br !bg-good-soft !text-good-text',
      error: '!border-bad-soft-br !bg-bad-soft !text-bad-text',
      warning: '!border-warn-soft-br !bg-warn-soft !text-warn-text',
      // `order-last`: en el DOM viene primero, y sin esto se dibuja a la
      // izquierda del mensaje. El área de toque se conserva; lo que desaparece
      // es el borde y el relleno blanco que lo convertían en un agujero.
      closeButton: 'order-last -mr-1 -mt-2 grid size-11 shrink-0 place-items-center rounded-boton text-muted transition-colors hover:bg-rest hover:text-ink [&>svg]:size-4',
      actionButton: 'min-h-control shrink-0 rounded-boton bg-action px-4 text-white',
      cancelButton: 'min-h-control shrink-0 rounded-boton border border-line-strong px-4 text-ink',
    },
  }} />;
}

/** Puente para las pantallas que conservan su último resultado en estado React. */
export function AvisoResultado({ children, persistente = false, tono = 'warning' }: { children: ReactNode; persistente?: boolean; tono?: 'success' | 'error' | 'warning' }) {
  const id = useId();
  useEffect(() => {
    toast[tono](children, { id });
    return () => { toast.dismiss(id); };
  }, [children, id, tono]);
  // Un error que sustituye la pantalla necesita conservar una explicación.
  return persistente ? <section role="status" className="rounded-campo border border-warn-soft-br bg-warn-soft p-4 text-dato text-warn-text">{children}</section> : null;
}
