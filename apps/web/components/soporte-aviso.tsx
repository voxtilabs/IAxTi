'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// El aviso del modo soporte (#68, SPEC §22): si el soporte de IAxTi está
// mirando la cuenta, el tenant LO VE — ayudar sin violar la confianza.

export function SoporteAviso() {
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
