'use client';

import { AvisoResultado } from '@iaxti/ui/react';
import { Seccion } from '@iaxti/ui/react';

import { Bot } from 'lucide-react';

import { useState } from 'react';
import { Badge, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, useSession } from '@iaxti/ui/react';
import { SelectorDeAsistente, useAsistenteElegido } from './selector-de-asistente';
import { apiFetch, mensajeDeError } from '../lib/api';

// Modo autónomo (#49): la IA responde sola SOLO por horario o marca manual
// — jamás por defecto. Aquí viven el horario y los guardrails del tenant.

/**
 * Los guardrails, TODOS los que el servidor lee (#1232).
 *
 * Esta pantalla toca tres y tiene que REENVIAR los otros, porque el PUT
 * reemplaza `limits` completo (`limits = COALESCE($14::jsonb, limits)`): sin
 * reenviarlos, guardar la confianza mínima apagaría el pulso del evento y
 * borraría el aviso de escalada.
 */
interface LimitesDto {
  confidence_threshold?: number;
  max_agent_turns?: number;
  money_limit_clp?: number | null;
  handoff_user_id?: string | null;
  escalation_notice?: string;
  pulso?: Record<string, unknown>;
}

const LLAVES_DE_LIMITS: readonly (keyof LimitesDto)[] = [
  'confidence_threshold',
  'max_agent_turns',
  'money_limit_clp',
  'handoff_user_id',
  'escalation_notice',
  'pulso',
];

/**
 * Lo que vuelve al servidor: lo conocido, y nada más.
 *
 * Antes era un `{ ...limits }` pelado. Desde #1232 el PUT RECHAZA una llave
 * que nadie lee, así que un `limits` con basura heredada —hubo un
 * `max_executions_day` nombrado en el comentario de la migración desde el
 * primer día— dejaría esta pantalla sin poder guardar nada, y el error hablaría
 * de una llave que el dueño nunca escribió.
 */
function limitesConocidos(limits: LimitesDto): LimitesDto {
  const salida: Record<string, unknown> = {};
  for (const llave of LLAVES_DE_LIMITS) {
    if (limits[llave] !== undefined) salida[llave] = limits[llave];
  }
  return salida as LimitesDto;
}

interface AgenteDto {
  id: string;
  name: string;
  defaultMode: 'assist' | 'autonomous' | 'off';
  autonomousHours: { start?: string; end?: string; days?: number[] };
  limits: LimitesDto;
}

const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

// Los mismos valores que muestran los campos de hora, y se MANDAN los dos
// juntos: `inAutonomousHours` exige `start` y `end` para que la IA contente
// alguna vez, así que guardar solo el «desde» dejaba el modo prendido, el
// badge «Por horario» puesto y el asistente mudo para siempre (#1232).
const DESDE_POR_DEFECTO = '19:00';
const HASTA_POR_DEFECTO = '09:00';

export function ModoAutonomo() {
  const { config, session } = useSession();
  // Tomaba el primero de la lista: con dos asistentes, quien configuraba el
  // modo autónomo tocaba siempre ese creyendo que tocaba el que estaba
  // mirando — y este es el ajuste donde equivocarse se nota en la cara de
  // un cliente (#494).
  const { tenant, asistentes, elegido: agente, elegir, reemplazar } = useAsistenteElegido<AgenteDto>();
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  if (!tenant || asistentes === null) return <div className="mt-4 max-w-xl"><Skeleton className="h-24" /></div>;
  if (!agente) return null;

  const hours = agente.autonomousHours ?? {};
  const limits = limitesConocidos(agente.limits ?? {});
  const dias = hours.days ?? [1, 2, 3, 4, 5];
  const desde = hours.start ?? DESDE_POR_DEFECTO;
  const hasta = hours.end ?? HASTA_POR_DEFECTO;

  const guardar = async (cambios: Partial<AgenteDto>) => {
    setAviso(null);
    setGuardado(false);
    try {
      const actualizado = await apiFetch<AgenteDto>(config, session!, tenant, `/agents/${agente.id}`, {
        method: 'PUT',
        body: JSON.stringify(cambios),
      });
      reemplazar(actualizado);
      setGuardado(true);
    } catch (err) {
      setAviso(mensajeDeError(err));
    }
  };

  return (
    <Seccion className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="rotulo">Modo autónomo</span>
        <SelectorDeAsistente asistentes={asistentes} elegidoId={agente.id} onElegir={elegir} />
        {agente.defaultMode === 'autonomous' ? (
          <Badge role="warn"><Bot className="mr-1 inline-block size-3 align-[-0.1em]" aria-hidden />Por horario</Badge>
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
            defaultValue={desde}
            onBlur={(e) =>
              void guardar({ autonomousHours: { start: e.target.value, end: hasta, days: dias } })
            }
          />
          <span className="text-sm text-muted">a</span>
          <Input
            aria-label="Hasta"
            type="time"
            className="w-28"
            defaultValue={hasta}
            onBlur={(e) =>
              void guardar({ autonomousHours: { start: desde, end: e.target.value, days: dias } })
            }
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
                      start: desde,
                      end: hasta,
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
            onBlur={(e) => void guardar({ limits: { ...limits, confidence_threshold: Number(e.target.value) } })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-body">
          Turnos sin avanzar
          <Input
            type="number" min={2} max={20}
            defaultValue={limits.max_agent_turns ?? 5}
            onBlur={(e) => void guardar({ limits: { ...limits, max_agent_turns: Number(e.target.value) } })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-body">
          Tope de dinero (CLP)
          <Input
            type="number" min={1} step={1000}
            placeholder="Sin tope: siempre escala"
            defaultValue={limits.money_limit_clp ?? ''}
            onBlur={(e) => void guardar({ limits: { ...limits, money_limit_clp: e.target.value ? Number(e.target.value) : undefined } })}
          />
        </label>
      </div>

      {guardado && <AvisoResultado tono="success">Listo, quedó guardado.</AvisoResultado>}
      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
    </Seccion>
  );
}
