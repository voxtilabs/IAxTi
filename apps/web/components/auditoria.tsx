'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuditExplorer, useSession, type AuditFetcher } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// El libro del PROPIO negocio (#72): el mismo explorador del SuperAdmin,
// acotado por RLS y por el permiso audit.read. Que el dueño pueda auditarse
// solo es la mitad del valor de tener una cadena de hash.

export function Auditoria() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  useEffect(() => setTenant(selectedTenant()), []);

  const fetcher = useMemo<AuditFetcher | null>(() => {
    if (!session || !tenant) return null;
    const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();
    return {
      search: (p) => apiFetch(config, session, tenant, `/audit?${qs(p)}`),
      verify: () =>
        apiFetch(config, session, tenant, '/audit/verify', { method: 'POST', body: '{}' }),
      exportar: (format, p) =>
        apiFetch(config, session, tenant, `/audit/export?${qs({ ...p, format })}`),
    };
  }, [session, config, tenant]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (!fetcher) return null;
  return (
    <div>
      <p className="rotulo">Auditoría</p>
      <h1 className="mt-1 font-display text-xl font-bold text-ink">El libro de tu cuenta</h1>
      <p className="mb-4 mt-2 max-w-2xl text-sm text-muted">
        Cada acción queda encadenada por hash con la anterior: si alguien tocara una entrada, la
        verificación lo diría. Puedes revisarlo cuando quieras y llevarte el libro firmado.
      </p>
      <AuditExplorer fetcher={fetcher} />
    </div>
  );
}
