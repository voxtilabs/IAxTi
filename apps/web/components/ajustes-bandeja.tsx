'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Pantalla del ADMIN (#38, según Pulso §39): campos de 46 px con el número
// en mono, ayuda en --text-muted, UN solo botón primario, aviso al guardar.

interface Ajustes {
  assignmentMode: 'manual' | 'round_robin' | 'last_owner' | 'ia_horario';
  alertaSinDuenoMinutos: number;
  slaPrimeraRespuestaMinutos: number;
  horario: { dias: number[]; desde: string; hasta: string; zona: string };
  autoResolveDays: number;
  archiveAfterMonths: number | null;
}

const MODOS: { value: Ajustes['assignmentMode']; label: string; ayuda: string }[] = [
  { value: 'manual', label: 'Manual', ayuda: 'El equipo toma las conversaciones de la cola.' },
  { value: 'round_robin', label: 'Turno rotativo', ayuda: 'Recibe quien lleva más tiempo sin una nueva.' },
  { value: 'last_owner', label: 'Quien lo atendió la última vez', ayuda: 'El contacto vuelve a su vendedora.' },
  { value: 'ia_horario', label: 'La IA en horario autónomo', ayuda: 'Se activa cuando conectes el asistente (Fase 3).' },
];

export function AjustesBandeja() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [ajustes, setAjustes] = useState<Ajustes | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'error'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setAjustes(await apiFetch<Ajustes>(config, session, tenant, '/settings/bandeja'));
    } catch (err) {
      setAviso({ tono: 'error', texto: (err as Error).message });
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || !ajustes || guardando) return;
    setGuardando(true);
    setAviso(null);
    try {
      const guardado = await apiFetch<Ajustes>(config, session, tenant, '/settings/bandeja', {
        method: 'PUT',
        body: JSON.stringify(ajustes),
      });
      setAjustes(guardado);
      setAviso({ tono: 'ok', texto: 'Ajustes guardados.' });
    } catch (err) {
      setAviso({ tono: 'error', texto: (err as Error).message });
    } finally {
      setGuardando(false);
    }
  }

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (!ajustes) {
    return (
      <div className="max-w-xl">
        {aviso ? (
          <AvisoResultado persistente>
            {aviso.texto}
          </AvisoResultado>
        ) : (
          <div className="flex flex-col gap-4"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
        )}
      </div>
    );
  }

  const modo = MODOS.find((m) => m.value === ajustes.assignmentMode)!;

  return (
    <form onSubmit={guardar} className="max-w-xl">
      <p className="rotulo">Bandeja</p>
      <h2 className="mt-2 text-xl font-bold text-ink">Asignación y tiempos de respuesta</h2>

      <div className="mt-8 flex flex-col gap-8">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink">
            ¿Quién recibe las conversaciones nuevas?
          </span>
          <select
            className="h-control w-full rounded-campo border border-line-strong bg-field px-4 text-cuerpo text-ink"
            value={ajustes.assignmentMode}
            onChange={(e) =>
              setAjustes({ ...ajustes, assignmentMode: e.target.value as Ajustes['assignmentMode'] })
            }
          >
            {MODOS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <span className="mt-2 block text-sm text-muted">{modo.ayuda}</span>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink">
            Avisar al supervisor si una conversación nueva queda sin dueño después de
          </span>
          <span className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              className="dato w-28 text-base"
              value={ajustes.alertaSinDuenoMinutos}
              onChange={(e) => setAjustes({ ...ajustes, alertaSinDuenoMinutos: Number(e.target.value) })}
            />
            <span className="text-body">minutos</span>
          </span>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink">
            Tiempo máximo para la primera respuesta (SLA)
          </span>
          <span className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              className="dato w-28 text-base"
              value={ajustes.slaPrimeraRespuestaMinutos}
              onChange={(e) =>
                setAjustes({ ...ajustes, slaPrimeraRespuestaMinutos: Number(e.target.value) })
              }
            />
            <span className="text-body">minutos hábiles</span>
          </span>
          <span className="mt-2 block text-sm text-muted">
            El reloj corre solo dentro del horario hábil del negocio.
          </span>
        </label>

        <fieldset>
          <legend className="mb-2 block text-sm font-medium text-ink">Horario hábil (lunes a viernes)</legend>
          <span className="flex items-center gap-3">
            <Input
              type="time"
              className="dato w-32 text-base"
              value={ajustes.horario.desde}
              onChange={(e) => setAjustes({ ...ajustes, horario: { ...ajustes.horario, desde: e.target.value } })}
            />
            <span className="text-body">a</span>
            <Input
              type="time"
              className="dato w-32 text-base"
              value={ajustes.horario.hasta}
              onChange={(e) => setAjustes({ ...ajustes, horario: { ...ajustes.horario, hasta: e.target.value } })}
            />
            <span className="text-muted text-sm">hora de Chile</span>
          </span>
        </fieldset>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink">
            Cerrar conversaciones sin respuesta del cliente después de
          </span>
          <span className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              className="dato w-28 text-base"
              value={ajustes.autoResolveDays}
              onChange={(e) => setAjustes({ ...ajustes, autoResolveDays: Number(e.target.value) })}
            />
            <span className="text-body">días</span>
          </span>
          <span className="mt-2 block text-sm text-muted">
            La próxima corrida es a la hora en punto. Cerrar no borra nada: la historia queda.
          </span>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink">
            Archivar conversaciones resueltas después de
          </span>
          <span className="flex items-center gap-3">
            <Input
              type="number"
              min={0}
              className="dato w-28 text-base"
              value={ajustes.archiveAfterMonths ?? 0}
              onChange={(e) =>
                setAjustes({
                  ...ajustes,
                  archiveAfterMonths: Number(e.target.value) === 0 ? null : Number(e.target.value),
                })
              }
            />
            <span className="text-body">meses</span>
          </span>
          <span className="mt-2 block text-sm text-muted">
            La próxima corrida es a las 03:00, hora de Chile. Con 0 no se archiva. Las archivadas
            salen de la bandeja pero siguen en la búsqueda y en la ficha.
          </span>
        </label>
      </div>

      {aviso && (
        <AvisoResultado tono={aviso.tono === 'ok' ? 'success' : 'warning'}>
          {aviso.texto}
        </AvisoResultado>
      )}

      <div className="mt-8">
        <Button type="submit" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </form>
  );
}
