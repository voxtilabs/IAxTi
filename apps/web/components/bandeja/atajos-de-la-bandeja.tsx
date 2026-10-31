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
export function ListaDeAtajos({ columnas = true }: { columnas?: boolean }) {
  return (
    <dl className={columnas ? 'grid grid-cols-2 gap-3 text-dato' : 'flex flex-col gap-2 text-dato'}>
      {ATAJOS_DE_LA_BANDEJA.map((a) => (
        <div key={a.que} className={columnas ? 'contents' : 'flex items-baseline justify-between gap-4'}>
          <dt className="shrink-0">{a.teclas}</dt>
          <dd className={columnas ? '' : 'text-right text-body'}>{a.que}</dd>
        </div>
      ))}
    </dl>
  );
}
