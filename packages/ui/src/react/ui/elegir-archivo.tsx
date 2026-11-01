'use client';

import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * Elegir un archivo, con la piel del sistema (#1144).
 *
 * El `<input type="file">` nativo se dibuja con los controles del sistema
 * operativo y, lo que es peor, **con su idioma**: en una pantalla en español
 * decía «Choose Files · No file chosen». Es el mismo motivo por el que #537
 * prohibió los checkbox nativos, agravado — un cuadrado gris desentona, un
 * texto en inglés se lee como que la pantalla no está terminada.
 *
 * Había cuatro sitios con tres patrones: dos lo resolvían bien a mano —input
 * oculto más etiqueta con estilo—, uno a medias con `file:` y uno crudo. Una
 * quinta copia habría sido el mismo error con otra sintaxis.
 *
 * El input sigue siendo un input: no se simula con un botón y `click()`.
 * Arrastrar y soltar sobre la etiqueta, el teclado y los lectores de pantalla
 * siguen funcionando porque es el control real, solo que no se pinta.
 */
export function ElegirArchivo({
  acepta,
  varios = false,
  deshabilitado = false,
  etiqueta = 'Elegir archivo',
  ayuda,
  onElegir,
  className,
  'aria-label': ariaLabel,
}: {
  /** Igual que `accept`: `.csv,text/csv`. */
  acepta?: string;
  varios?: boolean;
  deshabilitado?: boolean;
  /** Lo que dice el control. En español, y diciendo qué archivo espera. */
  etiqueta?: string;
  /** Una línea debajo: qué formatos, qué tamaño. */
  ayuda?: ReactNode;
  onElegir: (archivos: FileList | null) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const id = useId();
  const [elegidos, setElegidos] = useState<string[]>([]);

  const recibir = (e: ChangeEvent<HTMLInputElement>) => {
    const lista = e.target.files;
    setElegidos(lista ? Array.from(lista).map((f) => f.name) : []);
    onElegir(lista);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={id}
          className={cn(
            'inline-flex min-h-control cursor-pointer items-center rounded-boton border border-line-strong bg-raised px-4 text-sm font-medium text-ink transition-colors hover:bg-rest',
            deshabilitado && 'pointer-events-none opacity-50',
          )}
        >
          {etiqueta}
        </label>
        <input
          id={id}
          type="file"
          accept={acepta}
          multiple={varios}
          disabled={deshabilitado}
          aria-label={ariaLabel ?? etiqueta}
          className="sr-only"
          onChange={recibir}
        />
        {/* Qué se eligió, en español. El nativo decía «No file chosen» y acá
            no decir nada es mejor que decirlo: antes de elegir, la etiqueta
            ya explica qué se espera. */}
        {elegidos.length > 0 && (
          <span className="dato min-w-0 truncate text-muted">
            {elegidos.length === 1 ? elegidos[0] : `${elegidos.length} archivos`}
          </span>
        )}
      </div>
      {ayuda && <p className="ayuda">{ayuda}</p>}
    </div>
  );
}
