'use client';

import { usePieza } from '../arranque';

// El aviso de retención en la ficha (#77, §39): el equipo sabe desde
// cuándo NO hay historial — sin sorpresas.

interface RetencionDto {
  cutoff: string | null;
  months: number | null;
}

export function RetencionAviso() {
  /**
   * La retención sale del arranque del shell (#761).
   *
   * Es de las que piden una vez y no cambian entre dos clics —viene con su
   * caché de cinco minutos, la misma clave y el mismo TTL que su ruta suelta—
   * así que pedirla otra vez al abrir cada conversación era pagar un viaje por
   * un dato que ya estaba en la mano.
   *
   * `sin-permiso` se trata como «no hay aviso» y no como un aviso vacío: quien
   * no tiene `tenant.settings` no debe leer una frase a medias sobre la
   * retención de su negocio.
   */
  const retencion = usePieza('retencion');
  const datos = retencion.dato as RetencionDto | undefined;

  if (!datos?.cutoff) return null;
  return (
    <p className="border-t border-line px-4 py-3 text-xs text-faint">
      Según tu plan ({datos.months} meses), el historial anterior al{' '}
      <span className="dato">{new Date(datos.cutoff).toLocaleDateString('es-CL')}</span> se elimina
      de forma definitiva.
    </p>
  );
}
