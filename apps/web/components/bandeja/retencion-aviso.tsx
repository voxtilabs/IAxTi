'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch } from '../../lib/api';

// El aviso de retención en la ficha (#77, §39): el equipo sabe desde
// cuándo NO hay historial — sin sorpresas.

interface RetencionDto {
  cutoff: string | null;
  months: number | null;
}

export function RetencionAviso() {
  const { session, config } = useSession();
  const [datos, setDatos] = useState<RetencionDto | null>(null);

  useEffect(() => {
    const tenant = selectedTenant();
    if (!session || !tenant) return;
    void apiFetch<RetencionDto>(config, session, tenant, '/settings/retencion')
      .then(setDatos)
      .catch(() => setDatos(null));
  }, [session, config]);

  if (!datos?.cutoff) return null;
  return (
    <p className="border-t border-line px-4 py-3 text-xs text-faint">
      Según tu plan ({datos.months} meses), el historial anterior al{' '}
      <span className="dato">{new Date(datos.cutoff).toLocaleDateString('es-CL')}</span> se elimina
      de forma definitiva.
    </p>
  );
}
