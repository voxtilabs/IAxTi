'use client';

import { Skeleton } from '@iaxti/ui/react';

/**
 * La silueta de un panel mientras llegan sus datos (#588, punto 3).
 *
 * Cinco secciones de Ajustes y Agenda hacían `return null` mientras cargaban:
 * la pantalla se dibujaba sin ellas y después aparecían, empujando hacia abajo
 * todo lo que ya estaba. El salto no es solo fealdad — mueve el botón que
 * alguien estaba por tocar.
 *
 * ## Por qué reproduce el ENVOLTORIO y no solo pone una caja gris
 *
 * El alto del contenido es la mitad del problema. Un esqueleto con el alto
 * interior exacto pero sin el `mt-10`, el borde de arriba y el `pt-8` de la
 * sección real salta igual, por la diferencia del marco. Así que el `className`
 * que recibe es LITERALMENTE el de la sección que va a reemplazar, y lo único
 * que se estima es el alto de adentro.
 *
 * El `aria-label` también es el mismo, y eso no es decorativo: es lo que
 * permite que una prueba mida el MISMO locator en los dos estados y compare.
 * El criterio del issue es «ningún esqueleto de alto distinto al del
 * contenido: medido, no a ojo», y a ojo es exactamente como se mide si los dos
 * estados no se pueden encontrar con el mismo selector.
 *
 * `aria-busy` para que un lector de pantalla diga que está cargando en vez de
 * leer una lista de cajas vacías.
 */
export function PanelCargando({
  etiqueta,
  className,
  alto,
  filas = 1,
  superficie = 'raised',
  conTitulo = true,
}: {
  etiqueta: string;
  className: string;
  /** Alto del contenido en px, MEDIDO contra el panel cargado. */
  alto: number;
  /**
   * En cuántas barras se reparte ese alto.
   *
   * No es decoración. El horario de atención cargado mide 864 px con sus cinco
   * franjas, así que un esqueleto que no salte tiene que ocupar los 864 — y
   * 800 px de un solo bloque gris pulsando es peor que el hueco que vinimos a
   * arreglar. Repartido en cinco barras ocupa lo mismo y además dice qué
   * viene: una lista de cinco cosas.
   */
  filas?: number;
  /**
   * Sobre qué superficie se dibuja, para que la barra NO sea del color de su
   * propio fondo.
   *
   * El esqueleto del horario de atención era literalmente invisible: su panel
   * es `bg-rest` y la barra de `Skeleton` también, así que ocupaba el lugar
   * correcto y no comunicaba nada. Lo cazó la comprobación de día/noche del
   * criterio 5, comparando el color de la barra con el de la sección.
   *
   * Pulso define TRES superficies y dice que una cuarta es señal de que algo
   * se está forzando, así que no se inventa un gris: la barra usa la otra.
   */
  superficie?: 'raised' | 'rest';
  conTitulo?: boolean;
}) {
  const barra = superficie === 'rest' ? 'bg-raised' : 'bg-rest';
  const HUECO = 8;
  const altoDeFila = Math.max(8, (alto - HUECO * (filas - 1)) / filas);
  return (
    <section aria-label={etiqueta} aria-busy="true" className={className}>
      {conTitulo && <Skeleton className={`h-5 w-56 max-w-full ${barra}`} />}
      <div
        className={conTitulo ? 'mt-3 flex flex-col' : 'flex flex-col'}
        style={{ gap: HUECO }}
      >
        {Array.from({ length: filas }, (_, i) => (
          <Skeleton key={i} className={`w-full ${barra}`} style={{ height: altoDeFila }} />
        ))}
      </div>
    </section>
  );
}
