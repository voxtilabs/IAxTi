'use client';

import { useMemo } from 'react';
import { AuditExplorer, EncabezadoDePagina, type AuditFetcher, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// El libro del PROPIO negocio (#72): el mismo explorador del SuperAdmin,
// acotado por RLS y por el permiso audit.read. Que el dueño pueda auditarse
// solo es la mitad del valor de tener una cadena de hash.

export function Auditoria() {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();

  const fetcher = useMemo<AuditFetcher | null>(() => {
    if (!session || !tenant) return null;
    const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();
    return {
      search: (p) => apiFetch(config, session, tenant, `/audit?${qs(p)}`),
      // El camino paginado (#799). La ruta devuelve `{ entries, nextCursor }`
      // solo cuando el parámetro `cursor` viene presente, y `qs` lo manda
      // porque el explorador lo pone —vacío en la primera página—.
      searchPaginado: (p) => apiFetch(config, session, tenant, `/audit?${qs(p)}`),
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
      <EncabezadoDePagina
        rotulo="AUDITORÍA"
        titulo="El libro de tu cuenta"
      />
      <p className="mb-4 mt-2 max-w-2xl text-sm text-muted">
        Cada acción queda encadenada por hash con la anterior: si alguien tocara una entrada, la
        verificación lo diría. Puedes revisarlo cuando quieras y llevarte el libro firmado.
      </p>
      <AuditExplorer fetcher={fetcher} />
    </div>
  );
}
