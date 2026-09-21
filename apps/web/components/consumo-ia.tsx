'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, fmtClp } from '../lib/api';

// Consumo de IA (#52): asistencias para el equipo, pesos para quien
// supervisa el gasto — siempre visible en la configuración, en mono.

interface UsoDto {
  used: number;
  limit: number | null;
  pct: number | null;
  exhausted: boolean;
  economicoConfigurado: boolean;
  costUsdMonth?: number;
  costClpMonth?: number;
  usdClpRate?: number;
  porDia?: Array<{ day: string; costUsd: number; executions: number }>;
}

export function ConsumoIA() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [uso, setUso] = useState<UsoDto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setUso(await apiFetch<UsoDto>(config, session, tenant, '/agents/usage'));
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (aviso) {
    return (
      <AvisoResultado persistente>
        {aviso}
      </AvisoResultado>
    );
  }
  if (!uso) return <div className="max-w-xl"><Skeleton className="h-40" /></div>;

  const pct = uso.pct ?? 0;

  return (
    <div className="max-w-xl">
      <EncabezadoDePagina
        rotulo="IA"
        titulo="Consumo del asistente"
      />

      <div className="mt-6 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <div className="flex items-baseline justify-between gap-4">
          <span className="rotulo">Asistencias este mes</span>
          {uso.exhausted ? (
            <Badge role={uso.economicoConfigurado ? 'warn' : 'bad'}>
              {uso.economicoConfigurado ? 'Al 100 % — modo económico' : 'Cuota completa'}
            </Badge>
          ) : pct >= 80 ? (
            <Badge role="warn">Al {pct} %</Badge>
          ) : null}
        </div>
        <p className="dato mt-2 text-3xl font-bold text-ink">
          {uso.used}
          {uso.limit !== null && <span className="text-lg text-muted"> / {uso.limit}</span>}
        </p>
        {uso.limit !== null && (
          <div className="mt-3 h-2 overflow-hidden rounded-boton bg-rest" role="progressbar"
               aria-valuenow={Math.min(pct, 100)} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`h-full rounded-boton ${pct >= 100 ? 'bg-bad' : pct >= 80 ? 'bg-warn' : 'bg-action'}`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        )}
        <p className="mt-3 text-sm text-muted">
          Cada respuesta, clasificación o sugerencia del asistente usa una asistencia. El tope lo
          define tu plan{uso.exhausted && !uso.economicoConfigurado ? ' — al completarlo, el asistente descansa hasta el próximo ciclo.' : '.'}
        </p>
      </div>

      {uso.costClpMonth !== undefined && (
        <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
          <span className="rotulo">Costo estimado del mes</span>
          <p className="dato mt-2 text-3xl font-bold text-ink">{fmtClp(uso.costClpMonth)}</p>
          <p className="dato mt-1 text-sm text-muted">
            USD {uso.costUsdMonth?.toFixed(4)} · tipo de cambio {uso.usdClpRate}
          </p>
          {uso.porDia && uso.porDia.length > 0 && (
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="rotulo py-1">Día</th>
                  <th className="rotulo py-1 text-right">Corridas</th>
                  <th className="rotulo py-1 text-right">USD</th>
                </tr>
              </thead>
              <tbody>
                {uso.porDia.map((d) => (
                  <tr key={d.day} className="border-t border-line">
                    <td className="dato py-1.5">{d.day}</td>
                    <td className="dato py-1.5 text-right">{d.executions}</td>
                    <td className="dato py-1.5 text-right">{d.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
