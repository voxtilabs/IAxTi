'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Skeleton, useSession } from '@iaxti/ui/react';
import type { BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// La pantalla de canales (#45): el estado del número EXPLICADO — un número
// bloqueado por Meta deja al cliente sin su canal de ventas.

interface NumeroDto {
  id: string;
  displayPhone: string | null;
  phoneNumberId: string;
  quality: 'green' | 'yellow' | 'red' | null;
  messagingLimit: string | null;
  businessPausedAt?: string | null;
}

interface CanalDto {
  id: string;
  kind: string;
  name: string;
  state: 'connecting' | 'active' | 'degraded' | 'disconnected';
  numbers: NumeroDto[];
}

const ESTADO_CANAL: Record<CanalDto['state'], { label: string; role: BadgeRole; ayuda: string }> = {
  connecting: { label: 'Conectando', role: 'neutral', ayuda: 'Terminando la conexión con el proveedor.' },
  active: { label: 'Activo', role: 'good', ayuda: 'Recibiendo y enviando con normalidad.' },
  degraded: { label: 'Degradado', role: 'warn', ayuda: 'Funciona con restricciones: revisa la calidad del número.' },
  disconnected: { label: 'Desconectado', role: 'bad', ayuda: 'Sin conexión: los mensajes no entran ni salen.' },
};

const CALIDAD: Record<string, { label: string; role: BadgeRole; ayuda: string }> = {
  green: { label: 'Calidad buena', role: 'good', ayuda: 'Meta ve buenas respuestas de tus clientes. Todo normal.' },
  yellow: { label: 'Calidad media', role: 'warn', ayuda: 'Algunos clientes reportaron o bloquearon mensajes. Cuida el contenido y la frecuencia.' },
  red: { label: 'Calidad baja', role: 'bad', ayuda: 'Meta puede restringir el número. Pausamos los envíos del negocio para protegerlo; responder conversaciones sigue funcionando.' },
};

export function Canales() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [canales, setCanales] = useState<CanalDto[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setCanales(await apiFetch<CanalDto[]>(config, session, tenant, '/channels'));
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  async function reactivar(numberId: string) {
    if (!session || !tenant) return;
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, `/whatsapp/numbers/${numberId}/resume`, { method: 'POST' });
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  return (
    <div className="max-w-2xl">
      <p className="rotulo">Canales</p>
      <h1 className="mt-1 font-display text-xl font-bold text-ink">Tus canales conectados</h1>

      {aviso && (
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          {aviso}
        </p>
      )}

      {canales === null ? (
        <div className="mt-6 flex flex-col gap-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : canales.length === 0 ? (
        <div className="mt-6 rounded-tarjeta border border-line bg-raised p-8">
          <h2 className="text-lg font-bold text-ink">Todavía no hay canales</h2>
          <p className="mt-2 max-w-prose text-body">
            Al conectar tu número de WhatsApp aparecerá aquí con su estado y la calidad que Meta le
            asigna. La conexión guiada llega con el onboarding.
          </p>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {canales.map((canal) => {
            const estado = ESTADO_CANAL[canal.state];
            return (
              <li key={canal.id} className="rounded-tarjeta border border-line bg-raised p-6">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-display font-bold text-ink">{canal.name}</span>
                    <span className="text-sm text-muted">{canal.kind}</span>
                  </span>
                  <Badge role={estado.role}>{estado.label}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted">{estado.ayuda}</p>

                {canal.numbers.map((n) => {
                  const calidad = n.quality ? CALIDAD[n.quality] : null;
                  return (
                    <div key={n.id} className="mt-4 rounded-campo border border-line bg-bg p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="dato text-ink">{n.displayPhone ?? n.phoneNumberId}</span>
                        {calidad && <Badge role={calidad.role}>{calidad.label}</Badge>}
                        {n.messagingLimit && (
                          <span className="dato text-muted">{n.messagingLimit}</span>
                        )}
                      </div>
                      {calidad && <p className="mt-2 text-sm text-body">{calidad.ayuda}</p>}
                      {n.businessPausedAt && (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <Badge role="warn">Envíos del negocio pausados</Badge>
                          <Button
                            variant="secundario"
                            size="chico"
                            onClick={() => void reactivar(n.id)}
                          >
                            Reactivar envíos
                          </Button>
                          <span className="text-xs text-muted">
                            No se reactivan solos: tú decides cuándo.
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
