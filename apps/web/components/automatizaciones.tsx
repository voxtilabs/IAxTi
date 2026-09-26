'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Checkbox,
  EstadoVacio,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Input,
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
  const [creando, setCreando] = useState(false);
  const [creandoSec, setCreandoSec] = useState(false);
  const [secuencia, setSecuencia] = useState({
    name: '',
    pasos: [{ horas: '24', accion: 'send_message', texto: '', soloSinRespuesta: true }],
  });
  const [nueva, setNueva] = useState({
    name: '',
    tipo: 'time' as 'event' | 'time',
    evento: 'conversation.created',
    base: 'no_reply',
    horas: '24',
    etapa: '',
    accion: 'add_note',
    texto: '',
  });

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

  /** Cambia un paso de la secuencia que se está armando. */
  function cambiarPaso(i: number, cambio: Partial<(typeof secuencia)['pasos'][number]>) {
    setSecuencia({
      ...secuencia,
      pasos: secuencia.pasos.map((p, n) => (n === i ? { ...p, ...cambio } : p)),
    });
  }

  /**
   * Crea la secuencia. Las horas de cada paso se cuentan DESDE EL ANTERIOR,
   * no desde el inicio: es lo que espera el dominio, y decirlo en la
   * etiqueta evita secuencias que se disparan todas juntas.
   */
  async function crearSecuencia() {
    if (creandoSec) return;
    setCreandoSec(true);
    try {
      const creada = await llamar('/automations/sequences', {
        method: 'POST',
        body: JSON.stringify({
          name: secuencia.name.trim(),
          steps: secuencia.pasos.map((p) => ({
            afterHours: Number(p.horas),
            onlyIfNoReply: p.soloSinRespuesta,
            action: {
              kind: p.accion,
              params:
                p.accion === 'create_activity'
                  ? { type: 'llamada', title: p.texto.trim(), dueHours: 4 }
                  : { body: p.texto.trim() },
            },
          })),
        }),
      });
      if (creada) {
        setSecuencia({
          name: '',
          pasos: [{ horas: '24', accion: 'send_message', texto: '', soloSinRespuesta: true }],
        });
      }
    } finally {
      setCreandoSec(false);
    }
  }

  /** Arma la forma que el dominio espera y deja que él valide el resto. */
  async function crearRegla() {
    if (creando) return;
    setCreando(true);
    try {
      const trigger =
        nueva.tipo === 'event'
          ? { kind: 'event', event: nueva.evento }
          : {
              kind: 'time',
              time: {
                base: nueva.base,
                hours: Number(nueva.horas),
                ...(nueva.base === 'in_stage' ? { stageName: nueva.etapa } : {}),
              },
            };
      const params =
        nueva.accion === 'create_activity'
          ? { type: 'llamada', title: nueva.texto.trim(), dueHours: 4 }
          : { body: nueva.texto.trim() };
      const creada = await llamar('/automations', {
        method: 'POST',
        body: JSON.stringify({
          name: nueva.name.trim(),
          trigger,
          actions: [{ kind: nueva.accion, params }],
        }),
      });
      // Solo se limpia si de verdad se creó: si el dominio la rechazó, lo
      // escrito sigue ahí para corregirlo.
      if (creada) setNueva({ ...nueva, name: '', texto: '' });
    } finally {
      setCreando(false);
    }
  }

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

      {/* Crear una regla propia (#480). `POST /automations` existe desde
          #62 y no la llamaba nadie: el negocio se quedaba con las tres de
          su rubro o con nada. El guard no lo veía porque el GET de la
          misma ruta sí tiene pantalla.

          La regla nace APAGADA, como ya la crea el servidor: primero la
          vista previa, después el interruptor. */}
      <form
        className="mt-4 flex flex-col gap-3 pulso-panel rounded-tarjeta border border-line bg-raised p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void crearRegla();
        }}
      >
        <span className="rotulo">Una regla tuya</span>
        <label className="text-sm">
          Cómo la vas a reconocer
          <Input
            className="mt-1"
            value={nueva.name}
            onChange={(e) => setNueva({ ...nueva, name: e.target.value })}
            placeholder="Avisar cuando una oportunidad se estanca"
          />
        </label>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Cuándo</legend>
          <span className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="chico"
              variant={nueva.tipo === 'event' ? 'secundario' : 'fantasma'}
              aria-pressed={nueva.tipo === 'event'}
              onClick={() => setNueva({ ...nueva, tipo: 'event' })}
            >
              Cuando pasa algo
            </Button>
            <Button
              type="button"
              size="chico"
              variant={nueva.tipo === 'time' ? 'secundario' : 'fantasma'}
              aria-pressed={nueva.tipo === 'time'}
              onClick={() => setNueva({ ...nueva, tipo: 'time' })}
            >
              Cuando pasa el tiempo
            </Button>
          </span>
          {nueva.tipo === 'event' ? (
            <Select value={nueva.evento} onValueChange={(v) => setNueva({ ...nueva, evento: v })}>
              <SelectTrigger aria-label="Qué tiene que pasar" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(EVENTO_LABEL).map(([v, label]) => (
                  <SelectItem key={v} value={v}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="flex flex-wrap items-end gap-2">
              <Select value={nueva.base} onValueChange={(v) => setNueva({ ...nueva, base: v })}>
                <SelectTrigger aria-label="Contando desde" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no_reply">sin respuesta del negocio</SelectItem>
                  <SelectItem value="in_stage">estancada en una etapa</SelectItem>
                </SelectContent>
              </Select>
              <label className="text-sm">
                Horas
                <Input
                  type="number"
                  min="1"
                  className="dato mt-1 w-24"
                  value={nueva.horas}
                  onChange={(e) => setNueva({ ...nueva, horas: e.target.value })}
                />
              </label>
              {nueva.base === 'in_stage' && (
                <label className="text-sm">
                  ¿En cuál?
                  <Input
                    className="mt-1 w-48"
                    value={nueva.etapa}
                    onChange={(e) => setNueva({ ...nueva, etapa: e.target.value })}
                    placeholder="Cotizado"
                  />
                </label>
              )}
            </span>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Qué hace</legend>
          <Select value={nueva.accion} onValueChange={(v) => setNueva({ ...nueva, accion: v })}>
            <SelectTrigger aria-label="Qué hace" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add_note">deja una nota interna</SelectItem>
              <SelectItem value="create_activity">crea una tarea</SelectItem>
              <SelectItem value="send_message">le manda un mensaje al cliente</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={nueva.texto}
            onChange={(e) => setNueva({ ...nueva, texto: e.target.value })}
            placeholder={nueva.accion === 'create_activity' ? 'Llamar para retomar' : 'Lo que dice la nota o el mensaje'}
          />
          {nueva.accion === 'send_message' && (
            // Lo dice el servidor igual, pero enterarse al guardar es
            // tarde: esto es lo que más se olvida.
            <span className="text-xs text-muted">
              Igual respeta consentimiento y horario de silencio: si no corresponde, no sale.
            </span>
          )}
        </fieldset>

        <span>
          <Button type="submit" disabled={creando || !nueva.name.trim() || !nueva.texto.trim()}>
            {creando ? 'Creando…' : 'Crear la regla (nace apagada)'}
          </Button>
        </span>
      </form>

      {/* Secuencias (#480). `POST /automations/sequences` existe desde
          #63 y no la llamaba nadie: la bandeja deja METER una conversación
          a una secuencia y no había forma de crear ninguna, así que el
          selector de la ficha estaba siempre vacío. */}
      <form
        className="mt-4 flex flex-col gap-3 pulso-panel rounded-tarjeta border border-line bg-raised p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void crearSecuencia();
        }}
      >
        <span className="rotulo">Una secuencia de seguimiento</span>
        <p className="text-sm text-muted">
          Varios pasos con espera entre medio. Se corta sola cuando el cliente responde, si el paso
          lo pide.
        </p>
        <label className="text-sm">
          Nombre
          <Input
            className="mt-1"
            value={secuencia.name}
            onChange={(e) => setSecuencia({ ...secuencia, name: e.target.value })}
            placeholder="Recuperar cotización sin respuesta"
          />
        </label>

        <ul className="flex flex-col gap-2">
          {secuencia.pasos.map((paso, i) => (
            <li key={i} className="flex flex-wrap items-end gap-2 rounded-campo border border-line bg-bg p-3">
              <label className="text-sm">
                {i === 0 ? 'Al empezar, esperar' : 'Después del anterior, esperar'}
                <span className="mt-1 flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    className="dato w-20"
                    value={paso.horas}
                    onChange={(e) => cambiarPaso(i, { horas: e.target.value })}
                  />
                  <span className="text-body">h</span>
                </span>
              </label>
              <label className="min-w-[12rem] flex-1 text-sm">
                Y entonces
                <Select value={paso.accion} onValueChange={(v) => cambiarPaso(i, { accion: v })}>
                  <SelectTrigger aria-label={`Qué hace el paso ${i + 1}`} className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="send_message">mandarle un mensaje</SelectItem>
                    <SelectItem value="add_note">dejar una nota interna</SelectItem>
                    <SelectItem value="create_activity">crear una tarea</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="min-w-[14rem] flex-1 text-sm">
                Texto
                <Input
                  className="mt-1"
                  value={paso.texto}
                  onChange={(e) => cambiarPaso(i, { texto: e.target.value })}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-body">
                <Checkbox
                  checked={paso.soloSinRespuesta}
                  onCheckedChange={(v) => cambiarPaso(i, { soloSinRespuesta: v === true })}
                />
                Solo si no respondió
              </label>
              {secuencia.pasos.length > 1 && (
                <Button
                  type="button"
                  variant="fantasma"
                  size="chico"
                  onClick={() =>
                    setSecuencia({
                      ...secuencia,
                      pasos: secuencia.pasos.filter((_, n) => n !== i),
                    })
                  }
                >
                  Quitar
                </Button>
              )}
            </li>
          ))}
        </ul>

        <span className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secundario"
            size="chico"
            onClick={() =>
              setSecuencia({
                ...secuencia,
                pasos: [...secuencia.pasos, { horas: '24', accion: 'send_message', texto: '', soloSinRespuesta: true }],
              })
            }
          >
            Agregar un paso
          </Button>
          <Button type="submit" disabled={creandoSec || !secuencia.name.trim()}>
            {creandoSec ? 'Creando…' : 'Crear la secuencia'}
          </Button>
        </span>
      </form>

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
