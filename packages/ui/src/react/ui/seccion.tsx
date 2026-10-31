'use client';

import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * Cómo se ve un bloque DENTRO de una pantalla (#1109).
 *
 * `EncabezadoDePagina` (#398) resolvió que todas las pantallas empiecen
 * igual, y su comentario dice por qué: «lo que hace que un producto se vea
 * terminado es que todas las pantallas empiecen igual». Lo que no tenía
 * equivalente eran los bloques de adentro, así que cada uno inventaba el
 * suyo. Medido en `/ajustes/ia` antes de esto: `max-w-xl` cinco veces,
 * `max-w-prose` tres, `max-w-2xl` una; `p-6` cinco, `p-5` una, `p-4` una.
 *
 * Tres anchos y tres rellenos bajando por una sola columna dejan el borde
 * derecho dentado, y eso se lee como **inacabado** antes de que nadie juzgue
 * una sola decisión de diseño. Nadie va a decir «los anchos no calzan»: van a
 * decir que se ve raro.
 *
 * ## Por qué un solo ancho y no una prop
 *
 * Un `ancho` configurable es el mismo problema con otra sintaxis: a la tercera
 * pantalla hay tres valores otra vez. Si un bloque necesita ocupar todo —una
 * tabla, la bandeja— no es una `Seccion`, es otra cosa, y conviene que el tipo
 * lo obligue a decirlo.
 *
 * La prosa de adentro sigue acotada por `max-w-prose`: el ancho del bloque es
 * para el bloque, no para la medida de línea.
 */
export interface SeccionProps {
  /** De qué es esto, en versales. Corto: "ARMA TU CRM", "CONSUMO". */
  rotulo?: string;
  /** El encabezado del bloque. Es un `h2`: la pantalla ya tiene su `h1`. */
  titulo?: string;
  /** Una frase que diga para qué sirve. No un párrafo. */
  apoyo?: ReactNode;
  /** Lo que se puede hacer acá. A la derecha del título. */
  accion?: ReactNode;
  children?: ReactNode;
  className?: string;
  /**
   * Nombre accesible cuando el bloque no lleva `titulo` visible. Con título
   * no hace falta: el `h2` ya nombra la región.
   */
  'aria-label'?: string;
}

export function Seccion({ rotulo, titulo, apoyo, accion, children, className, ...resto }: SeccionProps) {
  const encabezado = rotulo || titulo || apoyo || accion;
  return (
    <section
      aria-label={resto['aria-label']}
      className={cn(
        'pulso-panel mt-6 w-full max-w-seccion rounded-tarjeta border border-line bg-raised p-6',
        className,
      )}
    >
      {encabezado && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            {rotulo && <p className="rotulo">{rotulo}</p>}
            {titulo && <h2 className="text-balance font-display text-seccion text-ink">{titulo}</h2>}
            {apoyo && <p className="max-w-prose text-cuerpo text-body">{apoyo}</p>}
          </div>
          {/* No se encoge: en pantalla angosta baja entera en vez de quedar
              apretada contra el título. Igual que en el encabezado. */}
          {accion && <div className="shrink-0">{accion}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
