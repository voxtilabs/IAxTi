'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@iaxti/ui/react';
import { apiFetch, ApiError } from '../lib/api';
import { rangoReporte, type DashboardDto } from '../lib/reportes';
import { useSelectedTenant } from './tenant-switcher';

type Lectura = { datos: DashboardDto; actualizado: Date };

/** Memoria de esta vista, nunca almacenamiento persistente ni caché global.
 * Volver a un rango muestra su última lectura y SIEMPRE la revalida. */
export function useReporte(dias: number) {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const rango = rangoReporte(dias);
  const clave = `${rango.from}/${rango.to}`;
  const memoria = useMemo(() => new Map<string, Lectura>(), [tenant, session?.access_token, config.apiUrl]);
  const [estado, setEstado] = useState<{
    memoria: Map<string, Lectura>; clave: string; lectura?: Lectura; aviso?: string; cargando: boolean;
  } | null>(null);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!session || !tenant) return;
    const controller = new AbortController();
    setEstado({ memoria, clave, lectura: memoria.get(clave), cargando: true });
    void apiFetch<DashboardDto>(config, session, tenant,
      `/analytics/dashboard?from=${rango.from}&to=${rango.to}`, { signal: controller.signal })
      .then((datos) => {
        if (controller.signal.aborted) return;
        const lectura = { datos, actualizado: new Date() };
        memoria.delete(clave); memoria.set(clave, lectura);
        if (memoria.size > 3) memoria.delete(memoria.keys().next().value!);
        setEstado({ memoria, clave, lectura, cargando: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) memoria.clear();
        setEstado({ memoria, clave, lectura: memoria.get(clave), cargando: false,
          aviso: error instanceof Error ? error.message : 'No pudimos cargar tus reportes. Intenta nuevamente.' });
      });
    return () => controller.abort();
  }, [memoria, clave, rango.from, rango.to, config, session, tenant, intento]);

  // Una respuesta vieja nunca se dibuja bajo el nombre del nuevo rango o negocio.
  const actual = estado?.memoria === memoria && estado.clave === clave ? estado : null;
  const lectura = actual?.lectura ?? memoria.get(clave);
  return { tenant, rango, datos: lectura?.datos, actualizado: lectura?.actualizado,
    cargando: actual?.cargando ?? true, aviso: actual?.aviso,
    reintentar: () => setIntento((n) => n + 1) };
}
