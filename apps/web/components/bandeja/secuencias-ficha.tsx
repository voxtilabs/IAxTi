'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch } from '../../lib/api';

// El estado de las secuencias en la FICHA (#63): el seguimiento como
// proceso visible — en qué paso va, cuándo sigue, por qué se cortó.

interface SecuenciaDto {
  id: string;
  name: string;
  active: boolean;
  steps: Array<{ afterHours: number }>;
}

interface InscripcionDto {
  id: string;
  sequenceName?: string;
  currentStep: number;
  totalSteps?: number;
  status: 'running' | 'completed' | 'stopped';
  stopReason: string | null;
  nextRunAt: string | null;
}

const ESTADO: Record<InscripcionDto['status'], { label: string; role: 'good' | 'neutral' | 'warn' }> = {
  running: { label: 'Corriendo', role: 'good' },
  completed: { label: 'Completada', role: 'neutral' },
  stopped: { label: 'Cortada', role: 'warn' },
};

export function SecuenciasFicha({
  contactId,
  conversationId,
}: {
  contactId: string;
  conversationId: string;
}) {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [secuencias, setSecuencias] = useState<SecuenciaDto[]>([]);
  const [inscripciones, setInscripciones] = useState<InscripcionDto[]>([]);
  const [elegida, setElegida] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const [seqs, ins] = await Promise.all([
        apiFetch<SecuenciaDto[]>(config, session, tenant, '/automations/sequences').catch(() => []),
        apiFetch<InscripcionDto[]>(
          config, session, tenant,
          `/automations/sequences/enrollments?contactId=${contactId}`,
        ).catch(() => []),
      ]);
      setSecuencias(seqs.filter((s) => s.active));
      setInscripciones(ins);
    } catch {
      /* módulo apagado: la sección no aparece */
    }
  }, [config, session, tenant, contactId]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant || (secuencias.length === 0 && inscripciones.length === 0)) return null;

  const accion = async (path: string, body?: unknown) => {
    if (!session) return;
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, path, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="border-t border-line p-4">
      <p className="rotulo">Secuencias</p>
      {inscripciones.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {inscripciones.map((i) => (
            <li key={i.id} className="text-sm">
              <span className="flex items-center gap-2">
                <Badge role={ESTADO[i.status].role}>{ESTADO[i.status].label}</Badge>
                <span className="truncate font-bold text-ink">{i.sequenceName}</span>
                <span className="dato text-muted">
                  paso {Math.min(i.currentStep + (i.status === 'running' ? 1 : 0), i.totalSteps ?? 0)}/{i.totalSteps}
                </span>
                {i.status === 'running' && (
                  <Button
                    variant="fantasma"
                    size="chico"
                    className="ml-auto"
                    onClick={() => void accion(`/automations/sequences/enrollments/${i.id}/stop`)}
                  >
                    Detener
                  </Button>
                )}
              </span>
              {i.status === 'running' && i.nextRunAt && (
                <span className="dato mt-0.5 block text-faint">
                  siguiente paso {new Date(i.nextRunAt).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              {i.stopReason && i.status !== 'running' && (
                <span className="mt-0.5 block text-muted">{i.stopReason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {secuencias.length > 0 && !inscripciones.some((i) => i.status === 'running') && (
        <div className="mt-3 flex items-center gap-2">
          <Select value={elegida} onValueChange={setElegida}>
            <SelectTrigger aria-label="Secuencia" className="min-w-0 flex-1">
              <SelectValue placeholder="Iniciar seguimiento…" />
            </SelectTrigger>
            <SelectContent>
              {secuencias.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} · {s.steps.length} pasos
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="chico"
            disabled={!elegida}
            data-testid="iniciar-secuencia"
            onClick={() =>
              void accion(`/automations/sequences/${elegida}/enroll`, { conversationId })
            }
          >
            Iniciar
          </Button>
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
