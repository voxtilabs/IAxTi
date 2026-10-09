'use client';

import { useState } from 'react';
import { Badge, Skeleton, useSession } from '@iaxti/ui/react';
import { apiFetch, type PasoDeEtapaDto } from '../../lib/api';

/**
 * Por dónde pasó la oportunidad (#695).
 *
 * `deal_stage_history` guarda cada movimiento con su motivo desde el día uno
 * —el motivo es obligatorio al retroceder y al perder— y **ninguna pantalla lo
 * leía**: la regla existía, la escritura existía, y lo escrito no se podía ver.
 *
 * Se pide al abrir y no antes: en una ficha con varias oportunidades, traer la
 * historia de todas para que se mire una es pagar por nada.
 */
export function HistoriaDeEtapas({ dealId, tenant }: { dealId: string; tenant: string }) {
  const { config, session } = useSession();
  const [pasos, setPasos] = useState<PasoDeEtapaDto[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function cargar(abierto: boolean) {
    if (!abierto || pasos || !session) return;
    try {
      setPasos(await apiFetch<PasoDeEtapaDto[]>(config, session, tenant, `/deals/${dealId}/etapas`));
    } catch (e: unknown) {
      setAviso(e instanceof Error ? e.message : 'No pudimos cargar la historia de esta oportunidad.');
    }
  }

  const dia = (iso: string) =>
    new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });

  return <details className="mt-2" onToggle={(e) => void cargar((e.currentTarget as HTMLDetailsElement).open)}>
    <summary className="w-fit cursor-pointer text-xs text-action-text">Por dónde pasó</summary>
    {aviso && <p className="mt-2 text-xs text-warn-text">{aviso}</p>}
    {!pasos && !aviso && <Skeleton className="mt-2 h-12 w-full" />}
    {pasos && pasos.length === 0 && (
      <p className="mt-2 text-xs text-muted">Sin movimientos registrados todavía.</p>
    )}
    {pasos && pasos.length > 0 && <ol className="mt-2 flex flex-col gap-1">
      {pasos.map((p, i) => <li key={`${p.at}-${i}`} className="flex flex-wrap items-center gap-2 text-xs text-body">
        <span className="font-mono text-muted">{dia(p.at)}</span>
        <span className="text-ink">{p.from ? `${p.from.name} → ${p.to.name}` : `Nació en ${p.to.name}`}</span>
        {p.backward && <Badge role="warn">Volvió atrás</Badge>}
        {p.reason && <span className="min-w-0 text-muted">· {p.reason}</span>}
      </li>)}
    </ol>}
  </details>;
}
