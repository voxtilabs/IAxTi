'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Input, Skeleton, Switch, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Webhooks salientes (#76): tus sistemas reaccionan a lo que pasa en
// IAxTi sin polling. Firma HMAC con secreto rotable, y el panel de
// entregas dice exactamente qué salió y qué respondió tu servidor.

interface WebhookDto {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  disabledReason: string | null;
}

interface EntregaDto {
  id: string;
  eventName: string;
  status: 'pending' | 'ok' | 'failed';
  attempt: number;
  responseStatus: number | null;
  responseBody: string | null;
  createdAt: string;
}

const ESTADO_ENTREGA: Record<EntregaDto['status'], { label: string; role: 'good' | 'warn' | 'bad' }> = {
  ok: { label: 'Entregada', role: 'good' },
  pending: { label: 'Reintentando', role: 'warn' },
  failed: { label: 'Fallida', role: 'bad' },
};

export function WebhooksSalientes() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookDto[] | null>(null);
  const [eventos, setEventos] = useState<string[]>([]);
  const [entregas, setEntregas] = useState<EntregaDto[]>([]);
  const [url, setUrl] = useState('');
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setWebhooks(await apiFetch<WebhookDto[]>(config, session, tenant, '/webhooks-salientes'));
      setEventos(await apiFetch<string[]>(config, session, tenant, '/webhooks-salientes/eventos'));
      setEntregas(await apiFetch<EntregaDto[]>(config, session, tenant, '/webhooks-salientes/entregas'));
    } catch (err) {
      setAviso((err as Error).message);
      setWebhooks([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  const accion = async (path: string, init?: RequestInit) => {
    if (!session) return;
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, path, init);
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="max-w-2xl">
      <p className="rotulo">Webhooks</p>
      <h1 className="mt-1 font-display text-xl font-bold text-ink">Avísale a tus sistemas</h1>
      <p className="mt-2 text-sm text-muted">
        Cada evento que elijas llega firmado a tu URL (header{' '}
        <span className="dato">X-Iaxti-Signature</span>, HMAC-SHA256 con el secreto del webhook).
        Si tu servidor falla, reintentamos con espera creciente; si falla un día entero, lo
        apagamos y te avisamos.
      </p>

      <div className="mt-6 rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Nuevo webhook</span>
        <Input
          aria-label="URL del webhook"
          className="dato mt-3"
          placeholder="https://tu-sistema.cl/hooks/iaxti"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="rotulo mt-4">Eventos</p>
        <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {eventos.map((ev) => {
            const activo = elegidos.has(ev);
            return (
              <button
                key={ev}
                type="button"
                aria-pressed={activo}
                className={`dato rounded-boton border px-2 py-1 text-xs ${
                  activo ? 'border-action bg-action-soft text-action-text' : 'border-line bg-bg text-muted'
                }`}
                onClick={() => {
                  const set = new Set(elegidos);
                  if (activo) set.delete(ev);
                  else set.add(ev);
                  setElegidos(set);
                }}
              >
                {ev}
              </button>
            );
          })}
        </div>
        <Button
          className="mt-4"
          disabled={!url.trim() || elegidos.size === 0}
          data-testid="crear-webhook"
          onClick={() =>
            void accion('/webhooks-salientes', {
              method: 'POST',
              body: JSON.stringify({ url, events: [...elegidos] }),
            }).then(() => {
              setUrl('');
              setElegidos(new Set());
            })
          }
        >
          Crear webhook
        </Button>
      </div>

      <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Webhooks</span>
        {webhooks === null ? (
          <Skeleton className="mt-3 h-16" />
        ) : webhooks.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Todavía no hay webhooks.</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {webhooks.map((w) => (
              <li key={w.id} className="border-t border-line py-3 first:border-t-0">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="dato truncate text-sm font-bold text-ink">{w.url}</p>
                    <p className="dato text-muted">{w.events.join(' · ')}</p>
                    <p className="dato mt-1 break-all text-xs text-faint">firma: {w.secret}</p>
                    {w.disabledReason && (
                      <p className="mt-1 text-sm text-warn-text">Apagado: {w.disabledReason}</p>
                    )}
                  </div>
                  <Button
                    variant="fantasma"
                    size="chico"
                    onClick={() => void accion(`/webhooks-salientes/${w.id}/rotate`, { method: 'POST' })}
                  >
                    Rotar secreto
                  </Button>
                  <Switch
                    aria-label={`Activar ${w.url}`}
                    checked={w.active}
                    onCheckedChange={(v) =>
                      void accion(`/webhooks-salientes/${w.id}/active`, {
                        method: 'POST',
                        body: JSON.stringify({ active: v }),
                      })
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {entregas.length > 0 && (
        <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
          <span className="rotulo">Últimas entregas</span>
          <ul className="mt-2 flex flex-col gap-1.5">
            {entregas.slice(0, 12).map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-sm">
                <Badge role={ESTADO_ENTREGA[e.status].role}>{ESTADO_ENTREGA[e.status].label}</Badge>
                <span className="dato truncate text-body">{e.eventName}</span>
                {e.responseStatus !== null && (
                  <span className="dato text-faint">HTTP {e.responseStatus}</span>
                )}
                <span className="dato text-faint">intento {e.attempt}</span>
                {e.status === 'failed' && (
                  <Button
                    variant="fantasma"
                    size="chico"
                    className="ml-auto"
                    onClick={() => void accion(`/webhooks-salientes/entregas/${e.id}/retry`, { method: 'POST' })}
                  >
                    Reintentar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {aviso && (
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          {aviso}
        </p>
      )}
    </div>
  );
}
