'use client';

import { useEffect, useState } from 'react';
import {
  Badge, EstadoVacio, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Skeleton, useSession,
} from '@iaxti/ui/react';
import { apiFetch, type EmbudoDto, type PipelineDto } from '../lib/api';
import { useSelectedTenant } from './tenant-switcher';

/**
 * El embudo que se puede leer (#695).
 *
 * `won_at`, `lost_at` y la historia de etapas se escribían desde el día uno y
 * ninguna pantalla las mostraba. Los reportes decían, con todas sus letras,
 * «no representan un embudo de las conversaciones nuevas»: esto es ese embudo.
 *
 * Es una cohorte: sigue a las oportunidades CREADAS en el período hasta hoy,
 * aunque se hayan cerrado después. Por eso contesta si el embudo está
 * mejorando —compara camadas, no instantes— y por eso el período de esta
 * sección se declara aparte de las cifras de arriba.
 */
const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

function fmtDias(d: number | null): string {
  if (d === null) return '—';
  if (d < 1) return 'menos de un día';
  return `${d.toLocaleString('es-CL', { maximumFractionDigits: 1 })} ${d === 1 ? 'día' : 'días'}`;
}

export function EmbudoDeVentas({ from, to }: { from: string; to: string }) {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [pipelines, setPipelines] = useState<PipelineDto[] | null>(null);
  const [elegido, setElegido] = useState<string | null>(null);
  const [datos, setDatos] = useState<EmbudoDto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !tenant) return;
    const ac = new AbortController();
    void apiFetch<PipelineDto[]>(config, session, tenant, '/pipelines', { signal: ac.signal })
      .then((ps) => {
        if (ac.signal.aborted) return;
        setPipelines(ps);
        setElegido((actual) => actual ?? ps[0]?.id ?? null);
      })
      .catch(() => { if (!ac.signal.aborted) setPipelines([]); });
    return () => ac.abort();
  }, [config, session, tenant]);

  useEffect(() => {
    if (!session || !tenant || !elegido) return;
    const ac = new AbortController();
    setDatos(null);
    setAviso(null);
    void apiFetch<EmbudoDto>(
      config, session, tenant,
      `/pipelines/${elegido}/embudo?from=${from}&to=${to}`,
      { signal: ac.signal },
    )
      .then((d) => { if (!ac.signal.aborted) setDatos(d); })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setAviso(e instanceof Error ? e.message : 'No pudimos cargar el embudo.');
      });
    return () => ac.abort();
  }, [config, session, tenant, elegido, from, to]);

  if (pipelines !== null && pipelines.length === 0) return null;

  const abiertas = datos?.etapas.filter((e) => e.type === 'open') ?? [];
  const vacio = datos !== null && datos.oportunidades === 0;

  return <section className="pulso-panel mt-4 rounded-tarjeta border border-line bg-raised p-4 sm:p-6"
    aria-label="Embudo de ventas">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-seccion font-bold text-ink">Dónde se queda la gente</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          {datos?.definiciones.cohorte ??
            'Sigue a las oportunidades creadas en el período hasta hoy, etapa por etapa.'}
        </p>
      </div>
      {pipelines && pipelines.length > 1 && elegido && (
        <Select value={elegido} onValueChange={setElegido}>
          <SelectTrigger className="w-56" aria-label="Embudo"><SelectValue /></SelectTrigger>
          <SelectContent>
            {pipelines.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>

    {aviso && <p className="mt-4 text-sm text-warn-text">{aviso}</p>}

    {!datos && !aviso && <div className="mt-4 space-y-2" aria-label="Cargando el embudo">
      <Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" />
    </div>}

    {vacio && <EstadoVacio compacto className="mt-4"
      titulo="Todavía no hay oportunidades de este período"
      descripcion="Acá vas a ver cuántas pasaron por cada etapa, qué porcentaje avanzó, cuántos días toma ganar una y en qué etapa se cae la mayoría. Aparece solo con oportunidades creadas en el período: crea una desde una conversación o elige un período más amplio arriba."
      accion={{ etiqueta: 'Ver oportunidades', href: '/oportunidades' }} />}

    {datos && !vacio && <>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <article className="rounded-tarjeta border border-line p-4" title={datos.definiciones.ciclo}>
          <h3 className="text-xs uppercase tracking-wide text-muted">Ciclo de venta</h3>
          <strong className="mt-1 block font-mono text-xl text-ink">{fmtDias(datos.ciclo.promedioDias)}</strong>
          <p className="mt-1 text-xs text-muted">
            {datos.ciclo.muestras === 0
              ? 'Ninguna ganada todavía en este período.'
              : `Promedio de ${datos.ciclo.muestras} ${datos.ciclo.muestras === 1 ? 'oportunidad ganada' : 'oportunidades ganadas'}; mediana ${fmtDias(datos.ciclo.medianaDias)}.`}
          </p>
        </article>
        <article className="rounded-tarjeta border border-line p-4">
          <h3 className="text-xs uppercase tracking-wide text-muted">Se cae en</h3>
          <strong className="mt-1 block text-xl text-ink">{datos.seCaeEn?.name ?? '—'}</strong>
          <p className="mt-1 text-xs text-muted">
            {datos.seCaeEn
              ? `${datos.seCaeEn.perdidas} ${datos.seCaeEn.perdidas === 1 ? 'oportunidad se perdió' : 'oportunidades se perdieron'} saliendo de esa etapa.`
              : 'Ninguna oportunidad perdida en este período.'}
          </p>
        </article>
        <article className="rounded-tarjeta border border-line p-4">
          <h3 className="text-xs uppercase tracking-wide text-muted">En el período</h3>
          <strong className="mt-1 block font-mono text-xl text-ink">{datos.oportunidades}</strong>
          <p className="mt-1 text-xs text-muted">Oportunidades creadas, de este embudo.</p>
        </article>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Conversión etapa por etapa del embudo</caption>
          <thead><tr className="text-xs uppercase tracking-wide text-muted">
            <th className="p-2" scope="col">Etapa</th>
            <th className="p-2" scope="col" title={datos.definiciones.entraron}>Entraron</th>
            <th className="p-2" scope="col" title={datos.definiciones.avanzaron}>Avanzaron</th>
            <th className="p-2" scope="col" title={datos.definiciones.conversion}>Conversión</th>
            <th className="p-2" scope="col" title={datos.definiciones.perdidas}>Perdidas</th>
          </tr></thead>
          <tbody>{abiertas.map((e) => <tr className="border-t border-line" key={e.stageId}>
            <th className="p-2 font-normal text-ink" scope="row">{e.name}</th>
            <td className="p-2 font-mono">{e.entraron}</td>
            <td className="p-2 font-mono">{e.avanzaron}</td>
            <td className="p-2">
              {e.conversion === null
                ? <span className="font-mono text-muted">—</span>
                : <Badge role={e.conversion >= 0.5 ? 'good' : e.conversion > 0 ? 'warn' : 'neutral'}>
                    {pct(e.conversion)}
                  </Badge>}
            </td>
            <td className="p-2 font-mono">{e.perdidas > 0 ? e.perdidas : '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        Volver a una etapa anterior es normal y no descuenta un avance que ya pasó: cada oportunidad
        cuenta una vez por etapa.
      </p>
    </>}
  </section>;
}
