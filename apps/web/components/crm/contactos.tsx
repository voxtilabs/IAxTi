'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, DataTable, EstadoVacio, Input, Skeleton, useSession, type ColumnDef, type SortingState, type RowSelectionState } from '@iaxti/ui/react';
import { useSelectedTenant } from '../tenant-switcher';
import { crmClient } from '@iaxti/sdk';
import { EtiquetarSeleccion } from './etiquetar-seleccion';
import { apiDescargar } from '../../lib/api';

interface ContactoItem {
  id: string;
  phone: string | null;
  rut: string | null;
  lastActivityAt: string;
  name: string | null;
  email: string | null;
  origin: string;
  optedOutAt: string | null;
}

/** /contactos (#34): búsqueda, cursor y la puerta a la importación. */
export function Contactos() {
  const tenant = useSelectedTenant();
  return tenant ? <ContactosDelNegocio key={tenant} tenant={tenant} /> : <p className="text-muted">Elige un negocio en el selector.</p>;
}

function ContactosDelNegocio({ tenant }: { tenant: string }) {
  const { session, config } = useSession();
  const client = useMemo(() => session ? crmClient({ apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant }) : null, [config.apiUrl, session, tenant]);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'activity', desc: true }]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [currentCursor, setCurrentCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [loading, setLoading] = useState(false);
  const serial = useRef(0);
  function firstPage() { setCurrentCursor(undefined); setHistory([]); setSelection({}); }
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ContactoItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!client) return;
    const request = ++serial.current;
    setLoading(true); setAviso(null);
    try {
      const query = new URLSearchParams({ limit: '25', sort: sorting[0].id, order: sorting[0].desc ? 'desc' : 'asc' });
      if (q.trim()) query.set('q', q.trim());
      if (currentCursor) query.set('cursor', currentCursor);
      const res = await client.contacts<ContactoItem>(query);
      if (request === serial.current) { setItems(res.items); setCursor(res.nextCursor); }
    } catch (err) { if (request === serial.current) setAviso((err as Error).message); }
    finally { if (request === serial.current) setLoading(false); }
  }, [client, q, currentCursor, sorting]);
  useEffect(() => { void cargar(); return () => { serial.current++; }; }, [cargar]);

  /**
   * Llevarse la cartera en CSV (#460).
   *
   * `GET /contacts/exportar` existe desde #248 y no la llamaba nadie: se
   * podía importar una planilla y no sacarla. La contraparte de "trae tu
   * lista" es "llévatela cuando quieras", y sin botón esa promesa dependía
   * de escribirnos.
   */
  async function exportar() {
    if (!session || exportando) return;
    setExportando(true);
    try {
      const { texto, nombre } = await apiDescargar(config, session, tenant, '/contacts/exportar');
      // El BOM lo pone el servidor para que Excel en español abra los
      // acentos bien; acá se respeta el texto tal cual llegó.
      const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = nombre;
      a.click();
      URL.revokeObjectURL(url);
      setAviso(null);
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setExportando(false);
    }
  }

  const columns: ColumnDef<ContactoItem, unknown>[] = [
    { id: 'name', accessorKey: 'name', header: 'Contacto', enableHiding: false, cell: ({ row }) => <div>
      <a className="block min-h-control break-words text-action-text" href={`/contactos/${row.original.id}`}><span className="block font-medium">{row.original.name ?? 'Sin nombre aún'}</span>
      <span className="block break-all font-mono text-muted">{row.original.phone}</span></a>
      {row.original.optedOutAt && <Badge role="bad">No contactar</Badge>}
    </div> },
    { id: 'origin', accessorKey: 'origin', header: 'Origen' },
    { id: 'rut', accessorKey: 'rut', header: 'RUT', enableSorting: false, cell: ({ row }) => <span className="font-mono">{row.original.rut ?? '—'}</span> },
    { id: 'activity', accessorKey: 'lastActivityAt', header: 'Actividad', cell: ({ row }) => <time dateTime={row.original.lastActivityAt} className="font-mono">{new Date(row.original.lastActivityAt).toLocaleDateString('es-CL')}</time> },
  ];
  return (
    <div className="max-w-5xl" data-densidad="densa">
      <div className="flex flex-wrap items-center gap-4">
        <EncabezadoDePagina titulo="Contactos" />
        <Button
          variant="secundario"
          className="ml-auto"
          disabled={exportando || items?.length === 0}
          onClick={() => void exportar()}
        >
          {exportando ? 'Armando el archivo…' : 'Exportar CSV'}
        </Button>
        <a
          href="/contactos/importar"
          className="inline-flex min-h-control items-center rounded-boton border border-line-strong px-4 text-sm font-medium text-ink transition-colors hover:bg-rest"
        >
          Importar CSV
        </a>
      </div>
      <Input
        type="search"
        aria-label="Buscar contactos"
        placeholder="Buscar por nombre o teléfono…"
        className="mt-4"
        value={q}
        onChange={(e) => { setQ(e.target.value); firstPage(); }}
      />
      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
      {items === null ? (
        <div className="mt-4 flex flex-col gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : items.length === 0 ? (
        <EstadoVacio className="mt-6"
          titulo={q.trim() ? `Nada con “${q.trim()}”` : 'Aquí empieza tu cartera de contactos'}
          descripcion={q.trim() ? 'Prueba con el teléfono o con parte del nombre.' : 'Cada persona que escriba aparece aquí con su historia. Si ya tienes una planilla, impórtala para empezar.'}
          accion={q.trim() ? { etiqueta: 'Limpiar búsqueda', onClick: () => { setQ(''); firstPage(); } } : { etiqueta: 'Importar contactos', href: '/contactos/importar' }}
        />
      ) : (
        <DataTable label="Contactos" columns={columns} rows={items} sorting={sorting}
          onSort={(sort) => { setSorting(sort); firstPage(); }} selection={selection} onSelection={setSelection}
          nextCursor={cursor} loading={loading} mobileColumns={['name']} canPrevious={history.length > 0}
          onNext={() => { if (cursor) { setHistory((h) => [...h, currentCursor]); setCurrentCursor(cursor); setSelection({}); } }}
          onPrevious={() => { setCurrentCursor(history.at(-1)); setHistory((h) => h.slice(0, -1)); setSelection({}); }}>
          <EtiquetarSeleccion tenant={tenant} contactIds={items.filter((c) => selection[c.id]).map((c) => c.id)} onDone={() => setSelection({})} />
        </DataTable>
      )}
    </div>
  );
}
