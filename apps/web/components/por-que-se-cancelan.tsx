'use client';

import { useCallback, useEffect, useState } from 'react';
import { Skeleton, useSession } from '@iaxti/ui/react';
import { apiFetch, type CancelacionesDto } from '../lib/api';
import { useSelectedTenant } from './tenant-switcher';

/**
 * Por qué se nos cancelan las visitas (#700).
 *
 * `appointments.cancel_reason` se escribía en cada cancelación desde el primer
 * día y ninguna consulta lo devolvía. Para un negocio con cinco visitas al día
 * es la pregunta del mes, y se contestaba abriendo la base — o no se contestaba.
 *
 * Los motivos se agrupan por el texto crudo y no por categorías: inventar una
 * taxonomía obligaría a mapear texto libre a cajas, y lo que no calza termina en
 * «otros», que es donde muere la información. El negocio escribe sus palabras y
 * las ve repetidas; cuando una se repita bastante, ahí vale la pena un botón.
 */
export function PorQueSeCancelan() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [datos, setDatos] = useState<CancelacionesDto | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setDatos(await apiFetch<CancelacionesDto>(config, session, tenant, '/agenda/cancelaciones'));
    } catch {
      // Sin permiso de agenda la sección no aparece; el resto de la pantalla
      // sigue funcionando.
      setSinPermiso(true);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (sinPermiso) return null;
  if (!datos) return <Skeleton className="h-24 w-full" />;
  // Sin cancelaciones no hay nada que contar, y un panel en cero ocupando
  // espacio en la agenda del día es ruido.
  if (datos.total === 0 && datos.desincronizadas.length === 0) return null;

  const mayor = datos.motivos[0]?.n ?? 1;

  return <section
    aria-label="Por qué se cancelan las horas"
    className="pulso-panel rounded-tarjeta border border-line bg-raised p-5"
  >
    <h2 className="font-display text-seccion font-bold text-ink">Por qué se caen las horas</h2>
    <p className="mt-1 max-w-prose text-sm text-muted">
      De las <span className="dato">{datos.total}</span>{' '}
      {datos.total === 1 ? 'hora cancelada' : 'horas canceladas'} en los últimos 90 días.
    </p>

    {datos.motivos.length > 0 ? (
      <ul className="mt-4 flex flex-col gap-2">
        {datos.motivos.map((m) => (
          <li key={m.motivo} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-body" title={m.motivo}>
              {m.motivo}
            </span>
            {/* La barra es proporcional al motivo más frecuente, no al total:
                con el total, dos motivos de 3 y 2 sobre 40 se ven iguales. */}
            <span aria-hidden className="h-2 rounded-boton bg-action-soft"
              style={{ width: `${Math.max(8, Math.round((m.n / mayor) * 100))}px` }} />
            <span className="dato w-8 text-right text-sm text-ink">{m.n}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="mt-3 text-sm text-muted">
        Ninguna cancelación tiene motivo escrito todavía. Cuando canceles una hora te lo vamos a
        preguntar, y acá vas a ver qué se repite.
      </p>
    )}

    {/* «No sabemos» se cuenta aparte y no como un motivo: mezclarlo haría que
        el más frecuente fuera siempre ése. */}
    {datos.sinMotivo > 0 && datos.motivos.length > 0 && (
      <p className="mt-3 text-xs text-muted">
        Otras <span className="dato">{datos.sinMotivo}</span> se cancelaron sin motivo escrito.
      </p>
    )}

    {/* Canceladas acá y vivas en Google: cada una ocupa una hora que el
        vendedor ve libre. */}
    {datos.desincronizadas.length > 0 && (
      <div className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft p-3">
        <p className="text-sm text-warn-text">
          {datos.desincronizadas.length === 1
            ? 'Una hora cancelada sigue ocupada en Google Calendar'
            : `${datos.desincronizadas.length} horas canceladas siguen ocupadas en Google Calendar`}
          .
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {datos.desincronizadas.slice(0, 5).map((d) => (
            <li key={d.appointmentId} className="text-xs text-body">
              <span className="dato">{new Date(d.startsAt).toLocaleString('es-CL')}</span> — {d.problema}
            </li>
          ))}
        </ul>
      </div>
    )}
  </section>;
}
