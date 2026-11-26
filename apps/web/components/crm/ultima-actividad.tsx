'use client';

/**
 * La última actividad, dicha relativa (#1395).
 *
 * Una fecha completa en cada fila obliga a hacer aritmética mental con el
 * calendario para contestar la pregunta real —«¿esta persona está viva para
 * mí?»—. La respuesta va en palabras: hoy, ayer, hace 3 días. Pasado un mes,
 * donde la precisión de la fecha importa más que la rapidez de lectura, se
 * muestra dd-mm-aaaa. El dato completo queda en el `title` y en el
 * `dateTime`, que es donde lo busca quien lo necesita.
 */

/** Días de calendario entre dos instantes, en la zona de quien mira. */
function diasDeCalendario(desde: Date, hasta: Date): number {
  const a = Date.UTC(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
  const b = Date.UTC(desde.getFullYear(), desde.getMonth(), desde.getDate());
  return Math.round((a - b) / 86_400_000);
}

/**
 * El texto relativo. El «ahora» va inyectado y no tomado del reloj: una prueba
 * que depende de la hora de la máquina pasa o se cae según cuándo se corra.
 */
export function actividadRelativa(iso: string, ahora: Date = new Date()): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '—';
  const dias = diasDeCalendario(fecha, ahora);
  // Un registro del futuro —reloj desincronizado— no se muestra como «hace -2
  // días»: para quien lee, ya pasó.
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias <= 6) return `hace ${dias} días`;
  if (dias <= 30) {
    const semanas = Math.floor(dias / 7);
    return semanas === 1 ? 'hace 1 semana' : `hace ${semanas} semanas`;
  }
  return fecha.toLocaleDateString('es-CL');
}

/** La celda de la lista: relativa en mono, completa en el title y el dateTime. */
export function UltimaActividad({ iso, ahora = new Date() }: { iso: string; ahora?: Date }) {
  const fecha = new Date(iso);
  const completa = Number.isNaN(fecha.getTime()) ? iso : fecha.toLocaleString('es-CL');
  return (
    <time dateTime={iso} title={completa} className="font-mono text-muted">
      {actividadRelativa(iso, ahora)}
    </time>
  );
}
