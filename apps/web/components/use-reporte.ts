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
  // La ventana la resuelve el SERVIDOR, que es quien conoce la zona del
  // negocio (#1074). El rango local queda como respaldo para dibujar algo
  // mientras llega la respuesta, y para la API vieja durante un despliegue.
  const respaldo = rangoReporte(dias);
  // La clave lleva el día además de la cantidad: antes cambiaba sola al
  // cambiar el `to`, y eso era lo que hacía que una pestaña abierta desde
  // ayer volviera a pedir. Con solo `${dias}d` el efecto no vuelve a correr
  // —`dias` no cambió— y la lectura de ayer se quedaría dibujada. Que el día
  // acá sea el del navegador y no el del negocio no importa: esto no mide
  // nada, solo decide cuándo refrescar.
  const clave = `${dias}d@${respaldo.to}`;
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
      `/analytics/dashboard?dias=${dias}`, { signal: controller.signal })
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
  }, [memoria, clave, dias, config, session, tenant, intento]);

  // Una respuesta vieja nunca se dibuja bajo el nombre del nuevo rango o negocio.
  const actual = estado?.memoria === memoria && estado.clave === clave ? estado : null;
  const lectura = actual?.lectura ?? memoria.get(clave);
  return { tenant, rango: lectura?.datos.rango ?? respaldo, datos: lectura?.datos, actualizado: lectura?.actualizado,
    cargando: actual?.cargando ?? true, aviso: actual?.aviso,
    reintentar: () => setIntento((n) => n + 1) };
}
