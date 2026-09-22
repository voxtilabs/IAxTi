'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  EstadoVacio,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Automatizaciones (#62, SPEC §15): que el seguimiento que hoy no se
// hace, se haga. Vista previa ANTES del interruptor — nada corre a ciegas.

interface ReglaDto {
  id: string;
  name: string;
  active: boolean;
  pauseReason: string | null;
  trigger:
    | { kind: 'event'; event: string }
    | { kind: 'time'; time: { base: string; hours: number; stageName?: string } };
  actions: Array<{ kind: string; params: Record<string, unknown> }>;
}

interface RunDto {
  id: string;
  ruleId: string;
  status: 'ok' | 'failed' | 'skipped' | 'deferred';
  detail: string | null;
  createdAt: string;
}

const VERTICALES = [
  { value: 'belleza', label: 'Belleza y estética' },
  { value: 'salud', label: 'Salud' },
  { value: 'inmobiliaria', label: 'Inmobiliaria' },
  { value: 'retail', label: 'Tienda / retail' },
  { value: 'servicios', label: 'Servicios profesionales' },
  { value: 'otro', label: 'Otro' },
];

const ACCION_LABEL: Record<string, string> = {
  add_note: 'deja nota',
  assign: 'asigna',
  send_message: 'envía mensaje',
  create_activity: 'crea tarea',
  move_stage: 'mueve de etapa',
};

const EVENTO_LABEL: Record<string, string> = {
  'conversation.created': 'llega una conversación nueva',
  'conversation.state_changed': 'cambia el estado de una conversación',
  'conversation.assigned': 'se asigna una conversación',
  'deal.created': 'se crea una oportunidad',
  'deal.stage_changed': 'una oportunidad cambia de etapa',
  'agent.escalated': 'la IA escala a humano',
};

function cuando(r: ReglaDto): string {
  if (r.trigger.kind === 'event') return `Cuando ${EVENTO_LABEL[r.trigger.event] ?? r.trigger.event}`;
  const t = r.trigger.time;
  if (t.base === 'no_reply') return `Tras ${t.hours} h sin respuesta`;
  return `Tras ${t.hours} h en ${t.stageName ?? 'la etapa'}`;
}

export function Automatizaciones() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [reglas, setReglas] = useState<ReglaDto[] | null>(null);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [vertical, setVertical] = useState('otro');
  const [aviso, setAviso] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ ruleId: string; items: Array<{ label: string }> } | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const [nuevosReglas, nuevosRuns] = await Promise.all([
        apiFetch<ReglaDto[]>(config, session, tenant, '/automations'),
        apiFetch<RunDto[]>(config, session, tenant, '/automations/runs'),
      ]);
      setReglas(nuevosReglas);
      setRuns(nuevosRuns);
    } catch (err) {
      setAviso((err as Error).message);
      setReglas([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  const llamar = async (path: string, init?: RequestInit) => {
    if (!session) return null;
    setAviso(null);
    try {
      const res = await apiFetch(config, session, tenant, path, init);
      await cargar();
      return res;
    } catch (err) {
      setAviso((err as Error).message);
      return null;
    }
  };

  return (
    <div className="max-w-2xl">
      <EncabezadoDePagina
        rotulo="AUTOMATIZACIONES"
        titulo="El seguimiento que hoy no se hace"
      />
      <p className="mt-2 text-sm text-muted">
        Reglas que trabajan cuando nadie está mirando — con las mismas leyes de siempre: nada sale
        sin consentimiento ni en horario de silencio. Mira la vista previa antes de encender.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Select value={vertical} onValueChange={setVertical}>
          <SelectTrigger aria-label="Rubro" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VERTICALES.map((v) => (
              <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="secundario"
          data-testid="reglas-iniciales"
          onClick={() => void llamar('/automations/seed', { method: 'POST', body: JSON.stringify({ vertical }) })}
        >
          Crear las 3 reglas del rubro
        </Button>
      </div>

      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Reglas</span>
        {reglas === null ? (
          <Skeleton className="mt-3 h-24" />
        ) : reglas.length === 0 ? (
          <EstadoVacio compacto className="mt-3" titulo="Prepara tus primeros seguimientos"
            descripcion="Aquí verás las reglas que ayudan a tu equipo a responder y dar seguimiento. Elige tu rubro arriba para partir con tres reglas que podrás revisar antes de activar."
            accion={{ etiqueta: 'Elegir rubro', onClick: () => document.querySelector<HTMLButtonElement>('[aria-label="Rubro"]')?.focus() }} />
        ) : (
          <ul className="mt-2 flex flex-col">
            {reglas.map((r) => (
              <li key={r.id} className="border-t border-line py-3 first:border-t-0">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink">{r.name}</p>
                    <p className="dato text-muted">
                      {cuando(r)} → {r.actions.map((a) => ACCION_LABEL[a.kind] ?? a.kind).join(' + ')}
                    </p>
                    {r.pauseReason && (
                      <p className="mt-1 text-sm text-warn-text">Pausada: {r.pauseReason}</p>
                    )}
                  </div>
                  <Button
                    variant="fantasma"
                    size="chico"
                    onClick={async () => {
                      const items = (await llamar(`/automations/${r.id}/preview`)) as
                        | Array<{ label: string }>
                        | null;
                      if (items) setPreview({ ruleId: r.id, items });
                    }}
                  >
                    ¿A quién hoy?
                  </Button>
                  <Switch
                    aria-label={`Activar ${r.name}`}
                    checked={r.active}
                    onCheckedChange={(v) =>
                      void llamar(`/automations/${r.id}/active`, {
                        method: 'POST',
                        body: JSON.stringify({ active: v }),
                      })
                    }
                  />
                </div>
                {preview?.ruleId === r.id && (
                  <p className="mt-2 rounded-campo border border-action-soft-br bg-action-soft px-3 py-2 text-sm text-body">
                    {preview.items.length === 0
                      ? 'Hoy no le aplicaría a nadie.'
                      : `Hoy le aplicaría a ${preview.items.length}: ${preview.items
                          .slice(0, 5)
                          .map((i) => i.label)
                          .join(', ')}${preview.items.length > 5 ? '…' : ''}`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {runs.length > 0 && (
        <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
          <span className="rotulo">Últimas corridas</span>
          <ul className="mt-2 flex flex-col gap-1">
            {runs.slice(0, 10).map((run) => (
              <li key={run.id} className="flex items-center gap-2 text-sm">
                <Badge role={run.status === 'ok' ? 'good' : run.status === 'failed' ? 'bad' : 'neutral'}>
                  {run.status}
                </Badge>
                <span className="truncate text-body">{run.detail ?? '—'}</span>
                <span className="dato ml-auto shrink-0 text-faint">
                  {new Date(run.createdAt).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
    </div>
  );
}
