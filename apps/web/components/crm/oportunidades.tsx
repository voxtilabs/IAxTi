'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

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
      {/* Dos líneas y no tres (#1155): el monto sube al lado del título. Con
          tres, una tarjeta medía 105 px y en una ventana de 900 entraban seis;
          el tablero es justamente la pantalla donde querés ver muchas de una.
          El monto queda a la derecha y en mono, que es donde el ojo lo busca
          cuando baja por una columna. */}
      <p className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-ink">{deal.title}</span>
        <span className="dato shrink-0 text-xs text-ink">
          {deal.currency === 'UF' && deal.value !== null ? `UF ${deal.value}` : fmtClp(deal.valueClp)}
        </span>
      </p>
      <p className="mt-1 flex items-center justify-between gap-2">
        <a href={`/contactos/${deal.contactId}`} className="truncate text-xs text-action-text">
          {deal.contactName ?? deal.contactPhone}
        </a>
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
  return tenant
    ? <OportunidadesDelNegocio key={tenant} tenant={tenant} />
    : <p className="p-6 text-muted">Elige un negocio en el selector.</p>;
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
  // Cuántas y cuánto hay DE VERDAD en cada etapa (#1155). Las columnas traen
  // veinte, así que su `items.length` no es el conteo de la etapa y su suma no
  // es el dinero de la etapa. Viene del servidor en una consulta para todo el
  // tablero.
  const [resumen, setResumen] = useState<Record<string, { cuantas: number; totalClp: number }>>({});

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

  const cargarResumen = useCallback(async () => {
    if (!pipelineId) return;
    try {
      const res = await api<{ items: { stageId: string; cuantas: number; totalClp: number }[] }>(
        `/deals/resumen?pipelineId=${pipelineId}`,
      );
      setResumen(Object.fromEntries(res.items.map((f) => [f.stageId, { cuantas: f.cuantas, totalClp: f.totalClp }])));
    } catch {
      // El tablero funciona sin los totales: lo que no se puede es mostrar un
      // número inventado en su lugar. Sin resumen, la cabecera muestra lo que
      // tiene cargado y lo dice.
      setResumen({});
    }
  }, [api, pipelineId]);

  useEffect(() => {
    if (!pipeline) return;
    for (const stage of pipeline.stages) void cargarColumna(stage);
    void cargarResumen();
  }, [pipeline, cargarColumna, cargarResumen]);

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
      void cargarResumen();
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

  if (!tenant) return <p className="p-6 text-muted">Elige un negocio en el selector.</p>;
  if (!pipelines) {
    return <div className="flex gap-4 p-6"><Skeleton className="h-64 w-72" /><Skeleton className="h-64 w-72" /></div>;
  }
  if (!pipeline) {
    return (
      <EstadoVacio className="m-6" titulo="Prepara las etapas de tus ventas"
        descripcion="Aquí verás tus oportunidades, ordenadas por etapa. Configura el negocio para crear el primer embudo."
        accion={{ etiqueta: 'Configurar mi negocio', href: '/ajustes/ia' }}
        pideleAIAxTi="Arma el embudo de mis ventas con las etapas que uso" />
    );
  }

  return (
    /* La pantalla NO scrollea: el alto lo fija la ventana (`sinMargen` en la
       página) y adentro scrollea cada columna. Así la cabecera de la etapa
       sigue a la vista mientras mirás sus tarjetas, que es la mitad de para
       qué sirve un tablero (#1155). */
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-4 px-6 pt-3">
        <EncabezadoDePagina titulo="Oportunidades" className="mb-0" />
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
        {/* Sin botón de IA acá: el topbar ya tiene «Pídeselo a IAxTi» en todas
            las pantallas, y dos botones con las mismas palabras a seis
            centímetros es lo que se lee como inacabado. Lo que el tablero sí
            necesitaba era que la capacidad exista, y existe: el Agente General
            tiene las operaciones del CRM entre sus herramientas —listar, mover
            de etapa, crear, renombrar el embudo, reordenar las etapas—, porque
            el catálogo se genera del OpenAPI de la API. */}
        <Tabs value={vista} onValueChange={(v) => setVista(v as typeof vista)} className="ml-auto">
          <TabsList>
            <TabsTrigger value="tablero">Tablero</TabsTrigger>
            <TabsTrigger value="lista">Lista</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {aviso && (
        <div className="shrink-0 px-6">
          <AvisoResultado>
            {aviso}
          </AvisoResultado>
        </div>
      )}

      {vista === 'tablero' && pipeline.stages.every((s) => columnas[s.id] && !columnas[s.id].cargando && columnas[s.id].items.length === 0) ? (
        <EstadoVacio className="m-6" titulo="Sin oportunidades abiertas"
          descripcion="Aquí verás cada venta en su etapa. Desde una conversación puedes crear la primera oportunidad y seguirla en este embudo."
          accion={{ etiqueta: 'Ir a una conversación', href: '/bandeja' }} />
      ) : vista === 'tablero' ? (
        /* Columnas deslizables: al Kanban se entra desde 360 px (§29). */
        /* `scroll-px-6` y no solo `px-6`: `snap-start` alinea la columna con el
             inicio del área de scroll, que NO incluye el relleno, así que al
             cargar el tablero se desplazaba 24 px solo y la primera columna
             quedaba pegada al borde izquierdo. Se vio en la captura de
             celular. */
          <div className="flex min-h-0 flex-1 snap-x scroll-px-6 gap-3 overflow-x-auto px-6 pb-6">
          {pipeline.stages.map((stage) => {
            const col = columnas[stage.id];
            const total = resumen[stage.id];
            return (
              <section
                key={stage.id}
                aria-label={`Etapa ${stage.name}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => soltar(e, stage)}
                className="flex min-w-72 max-w-[30rem] grow basis-72 snap-start flex-col pulso-panel rounded-tarjeta border border-line bg-raised"
              >
                {/* La cabecera no scrollea con las tarjetas: `shrink-0` acá y
                    el `overflow-y` en el cuerpo. */}
                <header className="shrink-0 border-b border-line px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="truncate text-sm font-bold text-ink">{stage.name}</h2>
                    <span className="dato shrink-0 text-muted">{total?.cuantas ?? col?.items.length ?? 0}</span>
                  </div>
                  {/* El dinero de la etapa, no el de lo cargado. Sin resumen no
                      se muestra nada: un total que miente es peor que ninguno,
                      porque nadie lo contrasta. */}
                  {total && total.cuantas > 0 && (
                    <p className="dato mt-0.5 text-xs text-body">{fmtClp(total.totalClp)}</p>
                  )}
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                  {col?.cargando && !col.items.length ? (
                    <Skeleton className="h-20" />
                  ) : col && !col.items.length ? (
                    /* Una etapa vacía es una columna de alto completo, porque
                       sigue siendo el destino de un arrastre. Lo que no puede
                       ser es un tubo gris sin una palabra: dice qué la llena. */
                    <p className="m-auto rounded-campo border border-dashed border-line px-3 py-2 text-center text-xs text-muted">
                      Arrastra una oportunidad acá
                    </p>
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
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
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
