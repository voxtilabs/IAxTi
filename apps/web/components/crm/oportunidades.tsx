'use client';

import { useCallback, useEffect, useState, type DragEvent } from 'react';
import {
  Badge,
  EstadoVacio,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import {
  apiFetch,
  fmtClp,
  type DealCardDto,
  type LossReasonDto,
  type PipelineDto,
  type SavedFilterDto,
  type StageDto,
} from '../../lib/api';

// Oportunidades (#33, SPEC §10/§29): tablero Kanban por pipeline con
// arrastre (motivo al retroceder, lista de motivos al perder) y lista con
// filtros guardados por usuario. Cursor SIEMPRE; a 360 px las columnas
// se deslizan. "Estancada" es texto, no solo color (§29).

interface Columna {
  items: DealCardDto[];
  cursor: string | null;
  cargando: boolean;
}

interface MovimientoPendiente {
  deal: DealCardDto;
  desde: StageDto;
  hasta: StageDto;
}

function TarjetaDeal({ deal, onDragStart }: { deal: DealCardDto; onDragStart: (e: DragEvent) => void }) {
  return (
    <article
      draggable
      onDragStart={onDragStart}
      className="cursor-grab rounded-campo border border-line bg-bg p-3 active:cursor-grabbing"
    >
      <p className="truncate text-sm font-medium text-ink">{deal.title}</p>
      <a href={`/contactos/${deal.contactId}`} className="mt-0.5 block truncate text-xs text-action-text">
        {deal.contactName ?? deal.contactPhone}
      </a>
      <p className="mt-2 flex items-center justify-between gap-2">
        <span className="dato text-ink">
          {deal.currency === 'UF' && deal.value !== null ? `UF ${deal.value}` : fmtClp(deal.valueClp)}
        </span>
        {deal.stalled && deal.status === 'open' && <Badge role="warn">Estancada</Badge>}
      </p>
    </article>
  );
}

export function Oportunidades() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineDto[] | null>(null);
  const [pipelineId, setPipelineId] = useState<string>('');
  const [vista, setVista] = useState<'tablero' | 'lista'>('tablero');
  const [columnas, setColumnas] = useState<Record<string, Columna>>({});
  const [motivos, setMotivos] = useState<LossReasonDto[]>([]);
  const [pendiente, setPendiente] = useState<MovimientoPendiente | null>(null);
  const [motivo, setMotivo] = useState('');
  const [motivoPerdidaId, setMotivoPerdidaId] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);

  // Lista
  const [lista, setLista] = useState<DealCardDto[]>([]);
  const [listaCursor, setListaCursor] = useState<string | null>(null);
  const [filtros, setFiltros] = useState<Record<string, string>>({});
  const [guardados, setGuardados] = useState<SavedFilterDto[]>([]);
  const [nombreFiltro, setNombreFiltro] = useState('');

  useEffect(() => setTenant(selectedTenant()), []);

  const api = useCallback(
    <T,>(path: string, init?: RequestInit) => {
      if (!session || !tenant) return Promise.reject(new Error('sin sesión'));
      return apiFetch<T>(config, session, tenant, path, init);
    },
    [config, session, tenant],
  );

  useEffect(() => {
    if (!session || !tenant) return;
    void api<PipelineDto[]>('/pipelines').then((p) => {
      setPipelines(p);
      setPipelineId((actual) => actual || p[0]?.id || '');
    }).catch((err) => setAviso((err as Error).message));
    void api<LossReasonDto[]>('/loss-reasons').then(setMotivos).catch(() => setMotivos([]));
    void api<SavedFilterDto[]>('/saved-filters').then(setGuardados).catch(() => setGuardados([]));
  }, [api, session, tenant]);

  const pipeline = pipelines?.find((p) => p.id === pipelineId) ?? null;

  const cargarColumna = useCallback(
    async (stage: StageDto, cursor?: string) => {
      setColumnas((prev) => ({
        ...prev,
        [stage.id]: { items: cursor ? prev[stage.id]?.items ?? [] : [], cursor: null, cargando: true },
      }));
      try {
        const res = await api<{ items: DealCardDto[]; nextCursor: string | null }>(
          `/deals?pipelineId=${pipelineId}&stageId=${stage.id}&limit=20${cursor ? `&cursor=${cursor}` : ''}`,
        );
        setColumnas((prev) => ({
          ...prev,
          [stage.id]: {
            items: cursor ? [...(prev[stage.id]?.items ?? []), ...res.items] : res.items,
            cursor: res.nextCursor,
            cargando: false,
          },
        }));
      } catch (err) {
        setAviso((err as Error).message);
      }
    },
    [api, pipelineId],
  );

  useEffect(() => {
    if (!pipeline) return;
    for (const stage of pipeline.stages) void cargarColumna(stage);
  }, [pipeline, cargarColumna]);

  const cargarLista = useCallback(
    async (cursor?: string) => {
      const query = new URLSearchParams({ pipelineId, limit: '25' });
      for (const [k, v] of Object.entries(filtros)) if (v) query.set(k, v);
      if (cursor) query.set('cursor', cursor);
      try {
        const res = await api<{ items: DealCardDto[]; nextCursor: string | null }>(`/deals?${query}`);
        setLista((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setListaCursor(res.nextCursor);
      } catch (err) {
        setAviso((err as Error).message);
      }
    },
    [api, pipelineId, filtros],
  );

  useEffect(() => {
    if (vista === 'lista' && pipelineId && session && tenant) void cargarLista();
  }, [vista, pipelineId, cargarLista, session, tenant]);

  async function ejecutarMovimiento(deal: DealCardDto, hasta: StageDto, extra: Record<string, string> = {}) {
    setAviso(null);
    try {
      await api(`/deals/${deal.id}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stageId: hasta.id, ...extra }),
      });
      const desde = pipeline?.stages.find((s) => s.id === deal.stageId);
      if (desde) void cargarColumna(desde);
      void cargarColumna(hasta);
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  function soltar(e: DragEvent, hasta: StageDto) {
    e.preventDefault();
    const dealId = e.dataTransfer.getData('text/deal');
    const todas = Object.values(columnas).flatMap((c) => c.items);
    const deal = todas.find((d) => d.id === dealId);
    const desde = pipeline?.stages.find((s) => s.id === deal?.stageId);
    if (!deal || !desde || desde.id === hasta.id) return;
    // Retroceder pide motivo; cerrar en perdido pide motivo de la lista (§10).
    if (hasta.type === 'lost' || (hasta.type === 'open' && hasta.position < desde.position)) {
      setMotivo('');
      setMotivoPerdidaId(motivos[0]?.id ?? '');
      setPendiente({ deal, desde, hasta });
      return;
    }
    void ejecutarMovimiento(deal, hasta);
  }

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (!pipelines) {
    return <div className="flex gap-4"><Skeleton className="h-64 w-72" /><Skeleton className="h-64 w-72" /></div>;
  }
  if (!pipeline) {
    return (
      <EstadoVacio titulo="Prepara las etapas de tus ventas"
        descripcion="Aquí verás tus oportunidades, ordenadas por etapa. Configura el negocio para crear el primer embudo."
        accion={{ etiqueta: 'Configurar mi negocio', href: '/ajustes/ia' }} />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="font-display text-titulo font-bold text-ink">Oportunidades</h1>
        {pipelines.length > 1 && (
          <select
            aria-label="Pipeline"
            className="h-9 rounded-campo border border-line-strong bg-field px-3 text-sm text-ink"
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <Tabs value={vista} onValueChange={(v) => setVista(v as typeof vista)} className="ml-auto">
          <TabsList>
            <TabsTrigger value="tablero">Tablero</TabsTrigger>
            <TabsTrigger value="lista">Lista</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {aviso && (
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-2 text-sm text-warn-text">
          {aviso}
        </p>
      )}

      {vista === 'tablero' && pipeline.stages.every((s) => columnas[s.id] && !columnas[s.id].cargando && columnas[s.id].items.length === 0) ? (
        <EstadoVacio className="mt-6" titulo="Sin oportunidades abiertas"
          descripcion="Aquí verás cada venta en su etapa. Desde una conversación puedes crear la primera oportunidad y seguirla en este embudo."
          accion={{ etiqueta: 'Ir a una conversación', href: '/bandeja' }} />
      ) : vista === 'tablero' ? (
        /* Columnas deslizables: al Kanban se entra desde 360 px (§29). */
        <div className="mt-6 flex snap-x gap-4 overflow-x-auto pb-4">
          {pipeline.stages.map((stage) => {
            const col = columnas[stage.id];
            return (
              <section
                key={stage.id}
                aria-label={`Etapa ${stage.name}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => soltar(e, stage)}
                className="flex w-72 shrink-0 snap-start flex-col rounded-tarjeta border border-line bg-raised"
              >
                <header className="flex items-center justify-between border-b border-line px-4 py-3">
                  <h2 className="text-sm font-bold text-ink">{stage.name}</h2>
                  <span className="dato text-muted">{col?.items.length ?? 0}</span>
                </header>
                <div className="flex min-h-24 flex-1 flex-col gap-2 p-3">
                  {col?.cargando && !col.items.length ? (
                    <Skeleton className="h-20" />
                  ) : (
                    col?.items.map((deal) => (
                      <TarjetaDeal
                        key={deal.id}
                        deal={deal}
                        onDragStart={(e) => e.dataTransfer.setData('text/deal', deal.id)}
                      />
                    ))
                  )}
                  {col?.cursor && (
                    <Button variant="fantasma" size="chico" onClick={() => void cargarColumna(stage, col.cursor!)}>
                      Cargar más
                    </Button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="mt-6">
          {/* Filtros + guardados por usuario. */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-muted">
              Etapa
              <select
                className="mt-1 block h-9 rounded-campo border border-line-strong bg-field px-3 text-sm text-ink"
                value={filtros.stageId ?? ''}
                onChange={(e) => setFiltros({ ...filtros, stageId: e.target.value })}
              >
                <option value="">Todas</option>
                {pipeline.stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm text-muted">
              Dueño
              <select
                className="mt-1 block h-9 rounded-campo border border-line-strong bg-field px-3 text-sm text-ink"
                value={filtros.owner ?? ''}
                onChange={(e) => setFiltros({ ...filtros, owner: e.target.value })}
              >
                <option value="">Según mi visibilidad</option>
                <option value="me">Solo las mías</option>
              </select>
            </label>
            <label className="text-sm text-muted">
              Valor desde
              <Input
                type="number"
                className="dato mt-1 h-9 w-32 text-sm"
                value={filtros.valueClpMin ?? ''}
                onChange={(e) => setFiltros({ ...filtros, valueClpMin: e.target.value })}
              />
            </label>
            <label className="text-sm text-muted">
              hasta
              <Input
                type="number"
                className="dato mt-1 h-9 w-32 text-sm"
                value={filtros.valueClpMax ?? ''}
                onChange={(e) => setFiltros({ ...filtros, valueClpMax: e.target.value })}
              />
            </label>
            <label className="text-sm text-muted">
              Etiqueta
              <Input
                className="mt-1 h-9 w-32 text-sm"
                value={filtros.tag ?? ''}
                onChange={(e) => setFiltros({ ...filtros, tag: e.target.value })}
              />
            </label>
            <Button variant="secundario" size="chico" onClick={() => void cargarLista()}>
              Filtrar
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {guardados.map((g) => (
              <Badge key={g.id} role="action">
                <button type="button" onClick={() => { setFiltros(g.filters); }}>
                  {g.name}
                </button>
                <button
                  type="button"
                  aria-label={`Borrar filtro ${g.name}`}
                  className="ml-1 opacity-60 hover:opacity-100"
                  onClick={() => {
                    void api(`/saved-filters/${g.id}`, { method: 'DELETE' }).then(() =>
                      setGuardados((prev) => prev.filter((x) => x.id !== g.id)),
                    );
                  }}
                >
                  ×
                </button>
              </Badge>
            ))}
            <Input
              placeholder="Guardar filtro como…"
              className="h-9 w-44 text-sm"
              value={nombreFiltro}
              onChange={(e) => setNombreFiltro(e.target.value)}
            />
            <Button
              variant="fantasma"
              size="chico"
              disabled={!nombreFiltro.trim()}
              onClick={() => {
                void api<SavedFilterDto>('/saved-filters', {
                  method: 'POST',
                  body: JSON.stringify({ name: nombreFiltro.trim(), filters: filtros }),
                }).then((g) => {
                  setGuardados((prev) => [...prev.filter((x) => x.name !== g.name), g]);
                  setNombreFiltro('');
                });
              }}
            >
              Guardar
            </Button>
          </div>

          <ul className="mt-4 flex flex-col gap-2">
            {lista.map((d) => (
              <li key={d.id} data-densidad="densa" className="flex min-h-control flex-wrap items-center gap-fila-gap rounded-campo border border-line bg-raised px-fila-x py-fila-y text-dato">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{d.title}</span>
                  <a href={`/contactos/${d.contactId}`} className="text-xs text-action-text">
                    {d.contactName ?? d.contactPhone}
                  </a>
                </span>
                <Badge role="neutral">{d.stageName}</Badge>
                {d.stalled && d.status === 'open' && <Badge role="warn">Estancada</Badge>}
                <span className="dato text-ink">
                  {d.currency === 'UF' && d.value !== null ? `UF ${d.value}` : fmtClp(d.valueClp)}
                </span>
              </li>
            ))}
          </ul>
          {lista.length === 0 && <EstadoVacio className="mt-4"
            titulo={Object.values(filtros).some(Boolean) ? 'Ninguna oportunidad coincide' : 'Sin oportunidades abiertas'}
            descripcion={Object.values(filtros).some(Boolean) ? 'Quita los filtros para volver a ver las oportunidades del embudo.' : 'Crea una oportunidad desde una conversación para seguir la venta por sus etapas.'}
            accion={Object.values(filtros).some(Boolean) ? { etiqueta: 'Limpiar filtros', onClick: () => setFiltros({}) } : { etiqueta: 'Ir a una conversación', href: '/bandeja' }} />}
          {listaCursor && (
            <Button variant="secundario" size="chico" className="mt-4" onClick={() => void cargarLista(listaCursor)}>
              Cargar más
            </Button>
          )}
        </div>
      )}

      {/* Motivo al retroceder o al perder (§10). */}
      <Dialog open={pendiente !== null} onOpenChange={(abierto) => !abierto && setPendiente(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendiente?.hasta.type === 'lost' ? 'Cerrar como perdida' : 'Retroceder de etapa'}
            </DialogTitle>
            <DialogDescription>
              {pendiente?.hasta.type === 'lost'
                ? 'Elige el motivo de la lista del negocio; queda en la historia.'
                : 'Cuéntanos el motivo; queda en la historia de la oportunidad.'}
            </DialogDescription>
          </DialogHeader>
          {pendiente?.hasta.type === 'lost' ? (
            <select
              aria-label="Motivo de pérdida"
              className={cn('h-control w-full rounded-campo border border-line-strong bg-field px-4 text-ink')}
              value={motivoPerdidaId}
              onChange={(e) => setMotivoPerdidaId(e.target.value)}
            >
              {motivos.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          ) : (
            <Input
              aria-label="Motivo"
              placeholder="Motivo del retroceso"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          )}
          <DialogFooter>
            <Button variant="secundario" onClick={() => setPendiente(null)}>Cancelar</Button>
            <Button
              disabled={pendiente?.hasta.type === 'lost' ? !motivoPerdidaId : !motivo.trim()}
              onClick={() => {
                if (!pendiente) return;
                const extra: Record<string, string> =
                  pendiente.hasta.type === 'lost'
                    ? { lostReasonId: motivoPerdidaId }
                    : { reason: motivo.trim() };
                void ejecutarMovimiento(pendiente.deal, pendiente.hasta, extra).then(() =>
                  setPendiente(null),
                );
              }}
            >
              {pendiente?.hasta.type === 'lost' ? 'Cerrar perdida' : 'Mover'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
