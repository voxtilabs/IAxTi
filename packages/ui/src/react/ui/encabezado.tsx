'use client';

import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * Cómo empieza una pantalla (#398).
 *
 * Antes cada una lo resolvía por su cuenta y ninguna igual que otra:
 * `font-display text-titulo text-ink` en campañas, `text-titulo
 * font-extrabold text-ink` en empresas —dos formas de decir lo mismo— y el
 * asistente abriendo con `<h2>`. Y la acción principal quedaba a miles de
 * caracteres del título: enterrada abajo, no donde el ojo va primero.
 *
 * Eso es lo que se lee como andamio, y no es el color: lo que hace que un
 * producto se vea terminado es que todas las pantallas empiecen igual.
 *
 * Usa la escala que ya existe (#297) en vez de `text-sm` para todo, que hoy
 * es el 70% del texto del producto:
 *
 *   rótulo   dónde estás, en mayúsculas pequeñas
 *   título   `text-titulo`, que es el único tamaño grande del sistema
 *   apoyo    `text-cuerpo`, una frase — no un párrafo
 *
 * `accion` es UNA sola: la regla de Pulso es un primario por vista, y este
 * es su lugar. Lo que cambia no es cuántos hay sino dónde está.
 */
export interface EncabezadoDePaginaProps {
  /** Dónde estás. Corto: "CAMPAÑAS", "TU ASISTENTE". */
  rotulo?: string;
  titulo: string;
  /** Una frase que diga para qué sirve esta pantalla. Opcional. */
  apoyo?: ReactNode;
  /** La acción principal. Una. */
  accion?: ReactNode;
  className?: string;
}

export function EncabezadoDePagina({
  rotulo,
  titulo,
  apoyo,
  accion,
  className,
}: EncabezadoDePaginaProps) {
  return (
    <header className={cn('mb-6 flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          {rotulo && <p className="rotulo">{rotulo}</p>}
          {/* `text-wrap: balance` para que un título de dos líneas no deje
              una palabra suelta abajo. */}
          <h1 className="text-balance font-display text-titulo text-ink">{titulo}</h1>
        </div>
        {/* La acción no se encoge: en pantalla angosta baja entera en vez
            de quedar apretada contra el título. */}
        {accion && <div className="shrink-0">{accion}</div>}
      </div>
      {apoyo && <p className="max-w-prose text-cuerpo text-body">{apoyo}</p>}
    </header>
  );
}
