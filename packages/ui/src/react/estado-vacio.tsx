'use client';

import { Button } from './ui/button';
import { cn } from './ui/cn';

type Accion = { etiqueta: string; href: string; onClick?: never } | { etiqueta: string; onClick: () => void; href?: never };

/** Cada lista vacía explica qué aparecerá y ofrece una acción concreta. */
export function EstadoVacio({ titulo, descripcion, accion, documentacion, compacto = false, className }: {
  titulo: string;
  descripcion: string;
  accion: Accion;
  documentacion?: { etiqueta: string; href: string };
  compacto?: boolean;
  className?: string;
}) {
  return <section aria-label={titulo} className={cn('rounded-tarjeta border border-line bg-raised', compacto ? 'p-4' : 'p-6', className)}>
    <h2 className="font-display text-lg font-bold text-ink">{titulo}</h2>
    <p className="mt-2 max-w-prose text-sm text-body">{descripcion}</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      {accion.href !== undefined ? <a href={accion.href} className="inline-flex min-h-control items-center rounded-boton border border-line-strong px-4 text-sm font-medium text-ink transition-colors hover:bg-rest">{accion.etiqueta}</a> :
        <Button variant="secundario" onClick={accion.onClick}>{accion.etiqueta}</Button>}
      {documentacion && <a href={documentacion.href} className="inline-flex min-h-control items-center text-sm text-action-text">{documentacion.etiqueta}</a>}
    </div>
  </section>;
}
