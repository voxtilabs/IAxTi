'use client';

import { Button } from './ui/button';
import { cn } from './ui/cn';

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
export function EstadoVacio({ titulo, descripcion, accion, pideleAIAxTi, documentacion, compacto = false, sinMarco = false, className }: {
  titulo: string;
  descripcion: string;
  accion: Accion;
  /** La pregunta con la que abrir el Agente General. Sin esto, no aparece. */
  pideleAIAxTi?: string;
  documentacion?: { etiqueta: string; href: string };
  compacto?: boolean;
  /**
   * Va DENTRO de otra tarjeta (#1344): sin borde, fondo, sombra ni radio
   * propios, porque una tarjeta adentro de otra se lee como un panel roto.
   * Tampoco lleva relleno: el de la tarjeta de afuera ya lo da, y sumar los
   * dos lo corría hacia adentro. Solo el vacío que ES la pantalla lleva marco.
   */
  sinMarco?: boolean;
  className?: string;
}) {
  return <section aria-label={titulo} data-compact={compacto} data-sin-marco={sinMarco || undefined} className={cn('pulso-empty', sinMarco ? undefined : 'pulso-panel rounded-tarjeta border border-line bg-raised', compacto ? 'p-4' : 'p-6', className)}>
    {/* Sin isotipo (Mesón, ADR-0034, #1346). Antes iba cuando el vacío ERA
        la pantalla (#1159): el jelly girado a 82 px le daba identidad a un
        callejón. En Mesón el jelly es lo único brillante del MARCO —la barra,
        el acceso, la portada— y adentro del trabajo se leía como adorno: lo
        que le da salida a un vacío es decir qué va a aparecer y la acción,
        y eso ya está abajo. */}
    <div className="min-w-0">
    {/* Sin marco va bajo el título de otra tarjeta: con su misma letra se leían
        dos títulos seguidos (#1344), así que baja a letra de texto. */}
    <h2 className={sinMarco ? 'text-cuerpo font-medium text-ink' : 'font-display text-seccion font-semibold text-ink'}>{titulo}</h2>
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
