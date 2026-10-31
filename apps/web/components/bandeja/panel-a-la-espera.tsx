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
  extra,
}: {
  /** Dónde estás, en versales. */
  rotulo: string;
  /** Qué va a aparecer acá y qué lo provoca. Una frase. */
  children: ReactNode;
  /** Solo si existe de verdad: en celular, volver a la lista. */
  accion?: ReactNode;
  /**
   * Un bloque debajo de la frase, FUERA del párrafo (#1111).
   *
   * No es `children` por dos razones y las dos importan: `children` vive en un
   * `<p>`, y una lista o una tabla dentro de un `<p>` es HTML inválido —el
   * navegador cierra el párrafo solo y el resultado deja de ser lo que dice el
   * código—; y `children` está acotado a `max-w-xs` a propósito, porque una
   * frase larga en una columna ancha no se lee.
   */
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="rotulo">{rotulo}</p>
      {/* UNA columna para la frase y el extra: con anchos distintos (320 y 352)
          la línea divisoria del extra no calzaba con los bordes del párrafo, y
          ese desajuste de 16 px por lado es justo lo que se lee como descuido
          sin que nadie sepa nombrarlo. Se vio en la captura. */}
      <div className="flex w-full max-w-[22rem] flex-col items-center gap-2">
        <p className="text-body">{children}</p>
        {accion}
        {extra}
      </div>
    </div>
  );
}
