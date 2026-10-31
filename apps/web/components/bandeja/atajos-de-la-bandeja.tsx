import type { ReactNode } from 'react';

/**
 * Los atajos de la bandeja, UNA vez (#1111).
 *
 * Estaban escritos a mano en el diálogo de ayuda. Cuando el panel de espera
 * empezó a mostrarlos también, copiarlos habría dejado dos listas que se
 * desincronizan el día que se agregue un atajo — y la que se desincroniza es
 * siempre la que nadie está mirando. Es el defecto más común de este repo:
 * declarado en un lado, no aplicado en el otro.
 *
 * `packages/ui` no es su lugar: estas teclas las implementa el `keydown` de
 * `bandeja.tsx`, así que la lista vive junto a lo que la hace verdad.
 */
export const ATAJOS_DE_LA_BANDEJA: { teclas: ReactNode; que: string }[] = [
  { teclas: <><kbd>j</kbd> / <kbd>k</kbd></>, que: 'Siguiente / anterior conversación' },
  { teclas: <kbd>e</kbd>, que: 'Resolver la conversación abierta' },
  { teclas: <kbd>?</kbd>, que: 'Mostrar esta ayuda' },
  { teclas: <><kbd>Ctrl+K</kbd> / <kbd>⌘K</kbd></>, que: 'Buscar o ir a una pantalla' },
];

/**
 * La lista, con la forma que sirve en los dos lugares donde aparece.
 *
 * `columnas` porque el diálogo es ancho y el panel de espera es una columna
 * angosta centrada: la misma grilla de dos columnas ahí partiría las frases.
 */
/**
 * La lista, con la forma que sirve en los dos lugares donde aparece.
 *
 * Las teclas en una columna propia y angosta, y las frases alineadas a la
 * izquierda en la suya. La primera versión usaba `justify-between`, y el
 * resultado renderizado era una tecla pegada al borde izquierdo y la frase
 * pegada al derecho con un hueco variable al medio: se lee como una tabla
 * rota, no como una lista. Se vio mirando la captura, no el código.
 */
export function ListaDeAtajos({ ancho = 'dialogo' }: { ancho?: 'dialogo' | 'panel' }) {
  return (
    <dl
      className={
        ancho === 'dialogo'
          ? 'grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-dato'
          : 'grid grid-cols-[5.5rem_1fr] gap-x-4 gap-y-2 text-dato'
      }
    >
      {ATAJOS_DE_LA_BANDEJA.map((a) => (
        <div key={a.que} className="contents">
          <dt className="whitespace-nowrap">{a.teclas}</dt>
          <dd className="text-body">{a.que}</dd>
        </div>
      ))}
    </dl>
  );
}
