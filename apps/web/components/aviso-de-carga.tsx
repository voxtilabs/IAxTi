'use client';

import { AvisoResultado, Button, toast } from '@iaxti/ui/react';
import type { Carga } from './use-carga';

/**
 * Las dos ramas de una carga que siempre se ven igual (#788).
 *
 * El esqueleto NO está acá y es a propósito: tiene que medir lo mismo que el
 * contenido real de cada pantalla, y eso solo lo sabe la pantalla —`#897` lo
 * midió panel por panel y los cinco altos salieron distintos, entre 159 y
 * 798 px—. Lo que sí es idéntico en todas es cómo se ve un 403 y cómo se ve
 * una caída, y eso es lo que estaba reescrito a mano en cada una.
 *
 * ## El 403 no lleva «Reintentar»
 *
 * Es la mitad del issue. Tres pantallas dibujaban «algo salió mal, intenta de
 * nuevo» a quien simplemente no tiene el permiso — y lo intenta, y vuelve a
 * fallar, y no hay nada que pueda hacer desde ahí. Un botón que no puede
 * funcionar nunca es peor que no tener botón: hace que la persona crea que el
 * producto está roto en vez de entender que esa parte no es para ella.
 *
 * Por omisión un 403 no dibuja NADA, que es la convención que ya seguían los
 * widgets del inicio y tres de las cinco pantallas de #588: sin permiso, la
 * sección no existe. `sinPermiso` es para cuando la ausencia confunde más que
 * la frase —una sección que el resto del equipo sí ve y vos no—.
 */
export function AvisoDeCarga({
  carga,
  onReintentar,
  sinPermiso,
}: {
  carga: Carga<unknown>;
  onReintentar: () => void;
  /** Frase para el 403. Sin ella, un 403 no dibuja nada. */
  sinPermiso?: string;
}) {
  if (carga.estado === 'sin-permiso') {
    return sinPermiso ? <p className="text-sm text-muted">{sinPermiso}</p> : null;
  }
  if (carga.estado !== 'falla') return null;

  const { texto, rastro } = carga.aviso;
  return (
    <AvisoResultado tono="error" persistente>
      {texto}
      {rastro && (
        /* El identificador, para pedir ayuda (#659) — y con su botón, porque
           desde un teléfono seleccionar texto chico es imposible. Esta forma
           ya existía escrita a mano en `bandeja/chat.tsx`; acá queda en un
           solo lugar. El vecino `bandeja.tsx` pinta el mismo rastro SIN el
           botón de copiar, que es justo la clase de diferencia que aparece
           cuando cada pantalla se lo arma sola. */
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <span className="dato text-rotulo text-muted">{rastro}</span>
          <button
            type="button"
            className="text-rotulo text-action-text underline"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(rastro)
                .then(() => toast.success('Copiado. Pásalo para que puedan buscarlo.'))
                .catch(() => toast.error('Tu navegador no dejó copiar. Selecciónalo a mano.'));
            }}
          >
            Copiar
          </button>
        </span>
      )}
      <span className="mt-2 block">
        <Button variant="fantasma" size="chico" onClick={onReintentar}>
          Reintentar
        </Button>
      </span>
    </AvisoResultado>
  );
}
