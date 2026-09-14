'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Modo autónomo (#49): la IA responde sola SOLO por horario o marca manual
// — jamás por defecto. Aquí viven el horario y los guardrails del tenant.

interface AgenteDto {
  id: string;
  name: string;
  defaultMode: 'assist' | 'autonomous' | 'off';
  autonomousHours: { start?: string; end?: string; days?: number[] };
  limits: {
    confidence_threshold?: number;
    max_agent_turns?: number;
    money_limit_clp?: number;
  };
}

const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

export function ModoAutonomo() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [agente, setAgente] = useState<AgenteDto | null>(null);
  const [cargado, setCargado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const lista = await apiFetch<AgenteDto[]>(config, session, tenant, '/agents');
      setAgente(lista[0] ?? null);
    } catch {
      setAgente(null);
    } finally {
      setCargado(true);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant || !cargado) return <div className="mt-4 max-w-xl"><Skeleton className="h-24" /></div>;
  if (!agente) return null;

  const hours = agente.autonomousHours ?? {};
  const limits = agente.limits ?? {};
  const dias = hours.days ?? [1, 2, 3, 4, 5];

  const guardar = async (cambios: Partial<AgenteDto>) => {
    setAviso(null);
    setGuardado(false);
    try {
      const actualizado = await apiFetch<AgenteDto>(config, session!, tenant, `/agents/${agente.id}`, {
        method: 'PUT',
        body: JSON.stringify(cambios),
      });
      setAgente(actualizado);
      setGuardado(true);
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="mt-4 max-w-xl rounded-tarjeta border border-line bg-raised p-6">
      <div className="flex items-baseline justify-between gap-4">
        <span className="rotulo">Modo autónomo</span>
        {agente.defaultMode === 'autonomous' ? (
          <Badge role="warn">✦ Por horario</Badge>
        ) : (
          <Badge role="neutral">Solo sugiere</Badge>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {agente.name} responde sola únicamente dentro del horario que definas aquí, o cuando tú
        enciendas el piloto automático en una conversación. Nunca por defecto. Ante enojo, temas de
        dinero fuera de rango o &quot;quiero hablar con una persona&quot;, te la pasa de vuelta y avisa.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-sm text-body">Cuando nadie mira</span>
        <Select
          value={agente.defaultMode}
          onValueChange={(v) => void guardar({ defaultMode: v as AgenteDto['defaultMode'] })}
        >
          <SelectTrigger aria-label="Modo por defecto" className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="assist">Solo sugiere (recomendado)</SelectItem>
            <SelectItem value="autonomous">Responde sola en el horario de abajo</SelectItem>
            <SelectItem value="off">Apagada</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {agente.defaultMode === 'autonomous' && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Input
            aria-label="Desde"
            type="time"
            className="w-28"
            defaultValue={hours.start ?? '19:00'}
            onBlur={(e) => void guardar({ autonomousHours: { ...hours, start: e.target.value, days: dias } })}
          />
          <span className="text-sm text-muted">a</span>
          <Input
            aria-label="Hasta"
            type="time"
            className="w-28"
            defaultValue={hours.end ?? '09:00'}
            onBlur={(e) => void guardar({ autonomousHours: { ...hours, end: e.target.value, days: dias } })}
          />
          <span className="ml-2 flex gap-1">
            {DIAS.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={dias.includes(i)}
                className={`h-8 w-8 rounded-boton border text-xs font-bold ${
                  dias.includes(i)
                    ? 'border-action bg-action-soft text-action-text'
                    : 'border-line bg-bg text-faint'
                }`}
                onClick={() =>
                  void guardar({
                    autonomousHours: {
                      ...hours,
                      days: dias.includes(i) ? dias.filter((x) => x !== i) : [...dias, i].sort(),
                    },
                  })
                }
              >
                {d}
              </button>
            ))}
          </span>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm text-body">
          Confianza mínima
          <Input
            type="number" min={0.1} max={1} step={0.05}
            defaultValue={limits.confidence_threshold ?? 0.7}
            onBlur={(e) => void guardar({ limits: { ...limits, confidence_threshold: Number(e.target.value) } } as Partial<AgenteDto>)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-body">
          Turnos sin avanzar
          <Input
            type="number" min={2} max={20}
            defaultValue={limits.max_agent_turns ?? 5}
            onBlur={(e) => void guardar({ limits: { ...limits, max_agent_turns: Number(e.target.value) } } as Partial<AgenteDto>)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-body">
          Tope de dinero (CLP)
          <Input
            type="number" min={0} step={1000}
            placeholder="Sin tope: siempre escala"
            defaultValue={limits.money_limit_clp ?? ''}
            onBlur={(e) => void guardar({ limits: { ...limits, money_limit_clp: e.target.value ? Number(e.target.value) : undefined } } as Partial<AgenteDto>)}
          />
        </label>
      </div>

      {guardado && <p className="mt-3 text-sm text-good-text">Listo, quedó guardado.</p>}
      {aviso && (
        <p role="alert" className="mt-3 rounded-campo border border-warn-soft-br bg-warn-soft px-3 py-2 text-sm text-warn-text">
          {aviso}
        </p>
      )}
    </div>
  );
}
