import type { ReactNode } from 'react';

/**
 * Un panel de la bandeja que espera a que elijas algo en OTRO panel (#1109).
 *
 * No es `EstadoVacio`, y el sistema de tipos tiene razón en no dejar que lo
 * sea: `EstadoVacio` exige una acción porque una lista vacía siempre tiene
 * uno —importar, conectar, limpiar la búsqueda— y una pantalla que solo dice
 * que está vacía es un callejón. Acá la acción existe pero vive al lado, en la
 * lista, así que inventarle un botón propio sería poner un callejón con
 * cartel.
 *
 * Lo que sí hacía falta es que los dos paneles lo digan IGUAL. Antes el chat
 * lo armaba a mano —rótulo centrado más una frase— y la ficha, en la misma
 * pantalla y a quince centímetros, usaba un `<p>` suelto arriba a la
 * izquierda. Dos lenguajes para lo mismo, uno al lado del otro, es
 * exactamente lo que se lee como inacabado.
 */
export function PanelALaEspera({
  rotulo,
  children,
  accion,
}: {
  /** Dónde estás, en versales. */
  rotulo: string;
  /** Qué va a aparecer acá y qué lo provoca. Una frase. */
  children: ReactNode;
  /** Solo si existe de verdad: en celular, volver a la lista. */
  accion?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="rotulo">{rotulo}</p>
      <p className="max-w-xs text-body">{children}</p>
      {accion}
    </div>
  );
}
