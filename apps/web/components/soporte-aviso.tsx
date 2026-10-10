'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// El aviso del modo soporte (#68, SPEC §22): si el soporte de IAxTi está
// mirando la cuenta, el tenant LO VE — ayudar sin violar la confianza.

export function SoporteAviso() {
  /**
   * Este aviso NO va en el arranque, y lo intenté (#761).
   *
   * El razonamiento con el que lo metí era el correcto a medias: #711 lo dejó
   * fuera del caché porque no es configuración, es el AVISO de que alguien de
   * IAxTi está mirando la cuenta, y un TTL de dos minutos son dos minutos en que
   * el soporte ya entró y el cliente no lo sabe. El arranque no se cachea, así
   * que parecía el lugar.
   *
   * Lo que no vi: **el arranque se pide una vez por sesión y no se vuelve a
   * pedir.** O sea que si el soporte entra diez minutos después de cargar la
   * pantalla, el aviso no aparece NUNCA — infinitamente peor que el TTL de dos
   * minutos que se había rechazado. Lo cazó el e2e de #68, que enciende el
   * soporte y recarga esperando verlo.
   *
   * La regla que sale de esto: una pieza que tiene que estar FRESCA no entra en
   * un agregado que se pide una vez. El arranque sirve para lo que vale lo mismo
   * en el segundo 1 y en el minuto 20.
   */
  const { session, config } = useSession();
  const [hasta, setHasta] = useState<string | null>(null);

  useEffect(() => {
    const tenant = selectedTenant();
    if (!session || !tenant) return;
    void apiFetch<{ active: boolean; until: string | null }>(
      config, session, tenant, '/support-status',
    )
      .then((s) => setHasta(s.active ? s.until : null))
      .catch(() => setHasta(null));
  }, [session, config]);

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
