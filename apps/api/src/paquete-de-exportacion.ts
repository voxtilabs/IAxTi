import { crearZip, csvSeguro, presignUrl, storageFromEnv } from '@iaxti/core';
import { TZ_POR_DEFECTO, diaEn } from '@iaxti/core';
import type { AdjuntoExportado, ExportacionTenant } from '@iaxti/module-organizations';

/**
 * El paquete que se lleva el negocio: un zip que abre con doble clic (#583).
 *
 * ## Qué estaba mal
 *
 * La pantalla armaba un `.json` en el navegador y lo bajaba. Dentro, los
 * adjuntos eran llaves PELADAS de R2 —rutas privadas del bucket— con el
 * comentario «los archivos se piden aparte», y no había ninguna ruta que los
 * pidiera. El cliente que cancelaba se llevaba la referencia a sus fotos,
 * cotizaciones y comprobantes, y no las fotos. El comentario de
 * `POST /billing/cancelar` decía «la exportación entera».
 *
 * ## Por qué enlaces firmados y no los bytes dentro del zip
 *
 * Meter los archivos adentro paga el egreso de R2 **dos veces** —R2 → API →
 * cliente— y, peor, la exportación se genera en la MISMA transacción que la
 * cancelación: un stream de cientos de MB colgando de una transacción abierta es
 * un problema más grande que el que resuelve. Con enlaces firmados el cliente
 * baja directo de R2, la transacción dura lo que dura una consulta, y no entra
 * ninguna dependencia nueva al lockfile.
 *
 * El costo asumido, dicho en el propio paquete y no solo acá: **los enlaces
 * vencen.** Siete días es el máximo que SigV4 permite firmar, así que es el
 * máximo que se puede ofrecer; el `LEEME.txt` lo dice con la fecha exacta y
 * explica que se vuelve a pedir la exportación si se pasaron.
 *
 * ## Por qué `crearZip` y no una librería
 *
 * Porque ya existe y ya corre en producción: un `.xlsx` ES un zip con XML
 * dentro, así que cada exportación de contactos a Excel pasa por este mismo
 * código (#709). El issue proponía portarlo a `fflate` por el riesgo de un CRC32
 * escrito a mano — y ese riesgo está medido al revés: Excel es uno de los
 * lectores de zip más estrictos que hay, rechaza el archivo completo si el CRC
 * no calza, y viene abriendo nuestros zips desde entonces.
 *
 * Lo que sí era cierto del issue: `crearZip` es sincrónico y arma todo en
 * memoria. Por eso este paquete son kilobytes —datos y texto— y no los
 * adjuntos.
 */

/** Siete días: el máximo que SigV4 permite firmar. */
export const VIGENCIA_DE_ENLACES_SEG = 7 * 24 * 60 * 60;

export interface PaqueteDeExportacion {
  zip: Buffer;
  nombre: string;
  /** Cuántos adjuntos quedaron con enlace. Cero si no hay almacén configurado. */
  conEnlace: number;
}


export function armarPaquete(
  exportacion: ExportacionTenant,
  opciones: { ahora?: Date; zona?: string } = {},
): PaqueteDeExportacion {
  const ahora = opciones.ahora ?? new Date();
  // La zona del negocio, porque el LEEME le habla a una persona (#1076). El
  // vencimiento es un INSTANTE: si cae a las 02:00 UTC, en Chile los enlaces
  // mueren a las 23:00 del día anterior al que decía este archivo, y quien se
  // guía por él se queda sin sus adjuntos.
  const zona = opciones.zona ?? TZ_POR_DEFECTO;
  const almacen = storageFromEnv();
  const vence = new Date(ahora.getTime() + VIGENCIA_DE_ENLACES_SEG * 1000);

  const conUrl = exportacion.adjuntos.map((a: AdjuntoExportado) => ({
    ...a,
    // Sin almacén configurado no se inventa una URL: el paquete sale con la
    // lista y el LEEME explica que hay que pedirlos. Mentir con un enlace roto
    // es peor que decir que falta.
    url: almacen ? presignUrl(almacen, 'GET', a.key, VIGENCIA_DE_ENLACES_SEG, ahora) : null,
  }));

  const adjuntosCsv = [
    ['nombre', 'conversacion', 'tipo', 'bytes', 'enlace'].join(';'),
    ...conUrl.map((a) =>
      [a.nombre, a.conversationId ?? '', a.contentType ?? '', a.bytes ?? '', a.url ?? '']
        .map((v) => csvSeguro(String(v)))
        .join(';'),
    ),
  ].join('\r\n');

  const nombreDelNegocio = String((exportacion.tenant as { name?: unknown }).name ?? 'tu negocio');
  const leeme = [
    `Exportación de ${nombreDelNegocio}`,
    `Generada el ${exportacion.generadoEl}`,
    '',
    'QUÉ HAY ACÁ',
    '',
    '  datos.json     Todo lo que guardamos de tu negocio, tabla por tabla.',
    '  ADJUNTOS.csv   Tus archivos: nombre, de qué conversación son, y el enlace',
    '                 para bajarlos. Se abre con Excel.',
    '',
    'LOS ENLACES VENCEN',
    '',
    `  Los enlaces de ADJUNTOS.csv funcionan hasta el ${diaEn(zona, vence)}.`,
    '  Después de esa fecha dejan de servir: si te pasaste, vuelve a pedir la',
    '  exportación y te damos enlaces nuevos.',
    '',
    `  Son ${conUrl.length} ${conUrl.length === 1 ? 'archivo' : 'archivos'}.`,
    ...(exportacion.adjuntosFuera > 0
      ? [
          '',
          `  OJO: ${exportacion.adjuntosFuera} archivos NO entraron en esta exportación,`,
          '  porque una exportación tiene un tope. Pídela de nuevo para llevarte el',
          '  resto, o escríbenos y la preparamos completa.',
        ]
      : []),
    ...(almacen
      ? []
      : [
          '',
          '  OJO: esta exportación salió sin enlaces porque el almacén de archivos no',
          '  estaba configurado. La lista de archivos sí está; escríbenos y te los',
          '  mandamos.',
        ]),
    ...(exportacion.truncadas.length > 0
      ? [
          '',
          'LO QUE NO SALIÓ COMPLETO',
          '',
          `  Estas tablas llegaron al tope y salieron parciales: ${exportacion.truncadas.join(', ')}.`,
          '  Escríbenos y te las preparamos completas.',
        ]
      : []),
    '',
    'LO QUE NO ESTÁ, Y POR QUÉ',
    '',
    ...Object.entries(exportacion.fuera).map(([que, porque]) => `  ${que}: ${porque}`),
    '',
  ].join('\n');

  const dia = ahora.toISOString().slice(0, 10);
  return {
    zip: crearZip(
      [
        { nombre: 'LEEME.txt', contenido: leeme },
        { nombre: 'datos.json', contenido: JSON.stringify({ ...exportacion, adjuntos: conUrl }, null, 2) },
        { nombre: 'ADJUNTOS.csv', // El BOM va como escape y no literal: un carácter invisible en el
        // código es un carácter que nadie ve al revisar. Y hace que Excel en
        // español abra los acentos bien — sin él, la ñ llega rota y el negocio
        // cree que perdimos su información.
        contenido: `\uFEFF${adjuntosCsv}` },
      ],
      ahora,
    ),
    nombre: `iaxti-${dia}.zip`,
    conEnlace: conUrl.filter((a) => a.url).length,
  };
}
