'use client';

import { usePieza } from './arranque';

// El aviso del modo soporte (#68, SPEC §22): si el soporte de IAxTi está
// mirando la cuenta, el tenant LO VE — ayudar sin violar la confianza.

export function SoporteAviso() {
  /**
   * El estado del soporte sale del arranque (#761), y sin caché.
   *
   * Vale repetir por qué esta pieza es la excepción deliberada de #711: no es
   * configuración, es el AVISO de que alguien de IAxTi está mirando la cuenta.
   * Un TTL de dos minutos son dos minutos en que el soporte ya entró y el
   * cliente todavía no lo sabe. Va en el arranque —que no se cachea entero,
   * justamente por esto— y no detrás de un TTL propio.
   */
  const soporte = usePieza('soporte');
  const dato = soporte.dato as { active?: boolean; until?: string | null } | undefined;
  const hasta = dato?.active ? (dato.until ?? null) : null;

  if (!hasta) return null;
  return (
    <p role="status" className="border-b border-warn-soft-br bg-warn-soft px-4 py-2 text-center text-sm text-warn-text">
      El soporte de IAxTi está revisando esta cuenta (solo lectura) hasta las{' '}
      <span className="dato">
        {new Date(hasta).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}
      </span>
      . Todo queda registrado.
    </p>
  );
}
