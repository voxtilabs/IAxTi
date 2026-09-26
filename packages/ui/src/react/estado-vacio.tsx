'use client';

import { Button } from './ui/button';
import { cn } from './ui/cn';
import { MarcaJelly } from './marca-jelly';

type Accion = { etiqueta: string; href: string; onClick?: never } | { etiqueta: string; onClick: () => void; href?: never };

/**
 * Cada lista vacía explica qué aparecerá y ofrece una acción concreta.
 *
 * Y, cuando corresponde, una segunda: pedírselo al Agente General con la
 * pregunta ya escrita (#509). Una pantalla vacía que solo dice que está vacía
 * es un callejón, y configurar conversando es la vía del producto (ADR-0025):
 * ahí es donde se nota si de verdad lo es.
 *
 * El puente es un evento del navegador y no una prop con el popup adentro:
 * este componente vive en `packages/ui` y no puede saber de la app. Mismo
 * patrón que `iaxti-tenant-changed`.
 */
export function EstadoVacio({ titulo, descripcion, accion, pideleAIAxTi, documentacion, compacto = false, className }: {
  titulo: string;
  descripcion: string;
  accion: Accion;
  /** La pregunta con la que abrir el Agente General. Sin esto, no aparece. */
  pideleAIAxTi?: string;
  documentacion?: { etiqueta: string; href: string };
  compacto?: boolean;
  className?: string;
}) {
  return <section aria-label={titulo} data-compact={compacto} className={cn('pulso-empty pulso-panel rounded-tarjeta border border-line bg-raised', compacto ? 'p-4' : 'p-6', className)}>
    <MarcaJelly />
    <div className="min-w-0">
    <h2 className="font-display text-seccion font-bold text-ink">{titulo}</h2>
    <p className="mt-2 max-w-prose text-dato text-body">{descripcion}</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      {accion.href !== undefined ? <a href={accion.href} className="inline-flex min-h-control items-center rounded-boton border border-line-strong px-4 text-dato font-medium text-ink transition-colors hover:bg-rest">{accion.etiqueta}</a> :
        <Button variant="secundario" onClick={accion.onClick}>{accion.etiqueta}</Button>}
      {pideleAIAxTi && <Button variant="fantasma" onClick={() => window.dispatchEvent(new CustomEvent('iaxti-preguntale', { detail: { pregunta: pideleAIAxTi } }))}>Pídeselo a IAxTi</Button>}
      {documentacion && <a href={documentacion.href} className="inline-flex min-h-control items-center text-dato text-action-text">{documentacion.etiqueta}</a>}
    </div>
    </div>
  </section>;
}
