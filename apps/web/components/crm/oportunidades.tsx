'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Badge, Button, DataTable, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EstadoVacio, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Tabs, TabsList, TabsTrigger, type ColumnDef, type RowSelectionState, type SortingState, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from '../tenant-switcher';
import {
  apiFetch,
  fmtClp,
  type DealCardDto,
  type LossReasonDto,
  type PipelineDto,
  type SavedFilterDto,
  type StageDto,
} from '../../lib/api';

import { crmClient } from '@iaxti/sdk';
import { EtiquetarSeleccion } from './etiquetar-seleccion';

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

// Radix no admite `value=""` en un item: la cadena vacía es su "sin
// selección". Los filtros "todas" y "según mi visibilidad" son opciones
// elegibles, así que van con centinela y se traducen al salir.
const TODAS = '__todas__';
const VISIBILIDAD = '__visibilidad__';

export function Oportunidades() {
  const tenant = useSelectedTenant();
  return tenant ? <OportunidadesDelNegocio key={tenant} tenant={tenant} /> : <p className="text-muted">Elige un negocio en el selector.</p>;
}

function OportunidadesDelNegocio({ tenant }: { tenant: string }) {
  const { session, config } = useSession();
  const client = useMemo(() => session ? crmClient({ apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant }) : null, [config.apiUrl, session, tenant]);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created', desc: true }]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [listaActual, setListaActual] = useState<string>();
  const [historialLista, setHistorialLista] = useState<Array<string | undefined>>([]);
  const [cargandoLista, setCargandoLista] = useState(false);
  const serialLista = useRef(0);
  function primeraLista() { setListaActual(undefined); setHistorialLista([]); setSelection({}); }
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
  const [filtros, guardarFiltros] = useState<Record<string, string>>({});
  const [guardados, setGuardados] = useState<SavedFilterDto[]>([]);
  const [nombreFiltro, setNombreFiltro] = useState('');

  function setFiltros(nuevos: Record<string, string>) { guardarFiltros(nuevos); primeraLista(); }

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

  const cargarLista = useCallback(async () => {
    if (!client) return;
    const request = ++serialLista.current;
    setCargandoLista(true); setAviso(null);
    const query = new URLSearchParams({ pipelineId, limit: '25', sort: sorting[0].id, order: sorting[0].desc ? 'desc' : 'asc' });
    for (const [k, v] of Object.entries(filtros)) if (v) query.set(k, v);
    if (listaActual) query.set('cursor', listaActual);
    try {
      const res = await client.deals<DealCardDto>(query);
      if (request === serialLista.current) { setLista(res.items); setListaCursor(res.nextCursor); }
    } catch (err) { if (request === serialLista.current) setAviso((err as Error).message); }
    finally { if (request === serialLista.current) setCargandoLista(false); }
  }, [client, pipelineId, filtros, sorting, listaActual]);

  useEffect(() => {
    if (vista === 'lista' && pipelineId && session && tenant) void cargarLista();
    return () => { serialLista.current++; };
  }, [vista, pipelineId, cargarLista, session, tenant]);

  const columnasLista: ColumnDef<DealCardDto, unknown>[] = [
    { id: 'title', accessorKey: 'title', header: 'Oportunidad', enableHiding: false, cell: ({ row }) => <div>
      <a href={`/contactos/${row.original.contactId}`} className="block min-h-control text-action-text"><span className="block font-medium text-ink">{row.original.title}</span><span>{row.original.contactName ?? row.original.contactPhone ?? 'Ver contacto'}</span></a>
      {row.original.stalled && row.original.status === 'open' && <Badge role="warn">Estancada</Badge>}
      <span className="block font-mono sm:hidden">{fmtClp(row.original.valueClp)}</span>
    </div> },
    { id: 'stage', accessorKey: 'stageName', header: 'Etapa' },
    { id: 'value', accessorKey: 'valueClp', header: 'Monto CLP', cell: ({ row }) => <span className="font-mono">{fmtClp(row.original.valueClp)}{row.original.currency === 'UF' && row.original.value !== null && <span className="block text-muted">UF {row.original.value}</span>}</span> },
    { id: 'created', header: 'Creada', accessorKey: 'createdAt', cell: ({ row }) => <time className="font-mono" dateTime={row.original.createdAt}>{new Date(row.original.createdAt).toLocaleDateString('es-CL')}</time> },
  ];

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
          <Select
            value={pipelineId}
            onValueChange={(valor) => { setPipelineId(valor); primeraLista(); }}
          >
            <SelectTrigger className="h-9 bg-field text-sm" aria-label="Pipeline"><SelectValue /></SelectTrigger>
            <SelectContent>
            {pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
            </Select>
        )}
        <Tabs value={vista} onValueChange={(v) => setVista(v as typeof vista)} className="ml-auto">
          <TabsList>
            <TabsTrigger value="tablero">Tablero</TabsTrigger>
            <TabsTrigger value="lista">Lista</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
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
                className="flex w-72 shrink-0 snap-start flex-col pulso-panel rounded-tarjeta border border-line bg-raised"
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
              <Select
                value={filtros.stageId ?? TODAS}
                onValueChange={(valor) => setFiltros({ ...filtros, stageId: valor === TODAS ? '' : valor })}
              >
                <SelectTrigger className="mt-1 h-9 w-full bg-field text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                <SelectItem value={TODAS}>Todas</SelectItem>
                {pipeline.stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            </label>
            <label className="text-sm text-muted">
              Dueño
              <Select
                value={filtros.owner || VISIBILIDAD}
                onValueChange={(valor) => setFiltros({ ...filtros, owner: valor === VISIBILIDAD ? '' : valor })}
              >
                <SelectTrigger className="mt-1 h-9 w-full bg-field text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={VISIBILIDAD}>Según mi visibilidad</SelectItem>
                  <SelectItem value="me">Solo las mías</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="text-sm text-muted">
              Valor desde (CLP)
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

          <DataTable label="Oportunidades" columns={columnasLista} rows={lista} sorting={sorting}
            onSort={(sort) => { setSorting(sort); primeraLista(); }} selection={selection} onSelection={setSelection}
            nextCursor={listaCursor} loading={cargandoLista} mobileColumns={['title']} canPrevious={historialLista.length > 0}
            onNext={() => { if (listaCursor) { setHistorialLista((h) => [...h, listaActual]); setListaActual(listaCursor); setSelection({}); } }}
            onPrevious={() => { setListaActual(historialLista.at(-1)); setHistorialLista((h) => h.slice(0, -1)); setSelection({}); }}>
            <EtiquetarSeleccion tenant={tenant} contactIds={lista.filter((d) => selection[d.id]).map((d) => d.contactId)} onDone={() => setSelection({})} />
          </DataTable>
          {lista.length === 0 && <EstadoVacio className="mt-4"
            titulo={Object.values(filtros).some(Boolean) ? 'Ninguna oportunidad coincide' : 'Sin oportunidades abiertas'}
            descripcion={Object.values(filtros).some(Boolean) ? 'Quita los filtros para volver a ver las oportunidades del embudo.' : 'Crea una oportunidad desde una conversación para seguir la venta por sus etapas.'}
            accion={Object.values(filtros).some(Boolean) ? { etiqueta: 'Limpiar filtros', onClick: () => { setFiltros({}); primeraLista(); } } : { etiqueta: 'Ir a una conversación', href: '/bandeja' }} />}

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
            <Select value={motivoPerdidaId} onValueChange={setMotivoPerdidaId}>
              <SelectTrigger className="h-control w-full bg-field" aria-label="Motivo de pérdida"><SelectValue /></SelectTrigger>
              <SelectContent>
              {motivos.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
              ))}
            </SelectContent>
            </Select>
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
