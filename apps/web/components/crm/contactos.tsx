'use client';

import { AvisoResultado, EncabezadoDePagina, EstadoVacio } from '@iaxti/ui/react';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import {
  Badge,
  Button,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconoPersona,
  iniciales,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useSession,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
} from '@iaxti/ui/react';
import { useSelectedTenant } from '../tenant-switcher';
import { crmClient } from '@iaxti/sdk';
import { EtiquetarSeleccion } from './etiquetar-seleccion';
import { Permiso } from './permiso';
import { CanalDelContacto } from './canal-del-contacto';
import { UltimaActividad } from './ultima-actividad';
import { DialogoNuevoContacto } from './nuevo-contacto';
import { apiDescargar, apiDescargarBinario, mensajeDeError } from '../../lib/api';
import { telefonoLegible } from '../../lib/telefono';

interface ContactoItem {
  id: string;
  phone: string | null;
  rut: string | null;
  lastActivityAt: string;
  name: string | null;
  email: string | null;
  origin: string;
  optedOutAt: string | null;
  /** Calculado por la API con la misma regla que el envío (#1346). */
  permiso?: 'baja' | 'opt_in' | 'escribio_primero' | 'sin_permiso';
}

/** /contactos (#34, #1395): buscar, filtrar por canal y permiso, y la puerta a la importación. */
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
  /** El canal por donde entró; `todos` es la ausencia de filtro. */
  const [origen, setOrigen] = useState('todos');
  /** Si se le puede escribir; `todos` es la ausencia de filtro. */
  const [permisoFiltro, setPermisoFiltro] = useState('todos');
  const [items, setItems] = useState<ContactoItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [nuevoAbierto, setNuevoAbierto] = useState(false);

  const cargar = useCallback(async () => {
    if (!client) return;
    const request = ++serial.current;
    setLoading(true); setAviso(null);
    try {
      const query = new URLSearchParams({ limit: '25', sort: sorting[0].id, order: sorting[0].desc ? 'desc' : 'asc' });
      if (q.trim()) query.set('q', q.trim());
      if (currentCursor) query.set('cursor', currentCursor);
      if (origen !== 'todos') query.set('filter[origen]', origen);
      if (permisoFiltro !== 'todos') query.set('filter[permiso]', permisoFiltro);
      const res = await client.contacts<ContactoItem>(query);
      if (request === serial.current) {
        // Un mock —o una API vieja— que responde sin lista no tumba la pantalla.
        setItems(Array.isArray(res.items) ? res.items : []);
        setCursor(res.nextCursor ?? null);
      }
    } catch (err) { if (request === serial.current) setAviso(mensajeDeError(err)); }
    finally { if (request === serial.current) setLoading(false); }
  }, [client, q, currentCursor, sorting, origen, permisoFiltro]);
  useEffect(() => { void cargar(); return () => { serial.current++; }; }, [cargar]);

  /**
   * Llevarse la cartera en CSV (#460) y en planilla (#709). El CSV queda para
   * quien la lleva a otro sistema; casi siempre lo que se quiere es ABRIRLA,
   * y ahí el CSV falla por el separador y por no tener tipos.
   */
  async function exportarXlsx() {
    if (!session || exportando) return;
    setExportando(true);
    try {
      const { blob, nombre } = await apiDescargarBinario(
        config,
        session,
        tenant,
        '/contacts/exportar.xlsx',
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombre;
      a.click();
      URL.revokeObjectURL(url);
      setAviso(null);
    } catch (err) {
      setAviso(mensajeDeError(err));
    } finally {
      setExportando(false);
    }
  }

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
      setAviso(mensajeDeError(err));
    } finally {
      setExportando(false);
    }
  }

  const columns: ColumnDef<ContactoItem, unknown>[] = [
    { id: 'name', accessorKey: 'name', header: 'Contacto', enableHiding: false, cell: ({ row }) => <div className="flex min-h-control items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-rest text-xs font-medium text-body" aria-hidden>
        {iniciales(row.original.name) ?? <IconoPersona className="size-4 text-muted" />}
      </span>
      <a className="block min-w-0 break-words text-ink hover:text-action-text hover:underline" href={`/contactos/${row.original.id}`}><span className="block font-medium">{row.original.name ?? 'Sin nombre aún'}</span>
      {row.original.phone && <span className="block break-all font-mono text-muted">{telefonoLegible(row.original.phone)}</span>}</a>
      {row.original.optedOutAt && <Badge role="bad">No contactar</Badge>}
    </div> },
    { id: 'origin', accessorKey: 'origin', header: 'Canal', cell: ({ row }) => <CanalDelContacto canal={row.original.origin} /> },
    { id: 'permiso', accessorKey: 'permiso', header: 'Permiso para escribirle', enableSorting: false, cell: ({ row }) => <Permiso valor={row.original.permiso} /> },
    { id: 'activity', accessorKey: 'lastActivityAt', header: 'Última actividad', cell: ({ row }) => <UltimaActividad iso={row.original.lastActivityAt} /> },
  ];
  /** Buscador y los dos filtros, en una fila: con tabla van en la de «Columnas» (Mesón, #1346) y sin tabla —cargando o vacía por filtro— van solos. */
  const filaDeFiltros = (clase = '') => (
    <div className={`flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-1 ${clase}`}>
      {/* Acotado (#1118): `max-w-xs`, el ancho del buscador de Empresas. */}
      <Input
        type="search"
        aria-label="Buscar contactos"
        placeholder="Buscar por nombre o teléfono"
        className="w-full sm:w-72"
        value={q}
        onChange={(e) => { setQ(e.target.value); firstPage(); }}
      />
      {/* En celular los dos filtros van lado a lado; en escritorio, en la fila del buscador. */}
      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
      <Select value={origen} onValueChange={(valor) => { setOrigen(valor); firstPage(); }}>
        <SelectTrigger className="h-9 w-full bg-field text-sm sm:w-44" aria-label="Canal">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="todos">Todos los canales</SelectItem>
          <SelectItem value="whatsapp">WhatsApp</SelectItem>
          <SelectItem value="webchat">Chat del sitio</SelectItem>
          <SelectItem value="instagram">Instagram</SelectItem>
          <SelectItem value="messenger">Messenger</SelectItem>
          <SelectItem value="importado">Importados</SelectItem>
          <SelectItem value="manual">Agregados a mano</SelectItem>
        </SelectContent>
      </Select>
      <Select value={permisoFiltro} onValueChange={(valor) => { setPermisoFiltro(valor); firstPage(); }}>
        <SelectTrigger className="h-9 w-full bg-field text-sm sm:w-48" aria-label="Permiso">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="todos">Cualquier permiso</SelectItem>
          <SelectItem value="puede">Se le puede escribir</SelectItem>
          <SelectItem value="sin_permiso">Sin permiso</SelectItem>
          <SelectItem value="baja">Se dio de baja</SelectItem>
        </SelectContent>
      </Select>
      </div>
    </div>
  );
  const conFiltros = Boolean(q.trim() || origen !== 'todos' || permisoFiltro !== 'todos');
  const quitarFiltros = () => { setQ(''); setOrigen('todos'); setPermisoFiltro('todos'); firstPage(); };
  return (
    <div className="max-w-5xl" data-densidad="densa">
      <div className="flex flex-wrap items-center gap-4">
        <EncabezadoDePagina titulo="Contactos" />
        {/* La jerarquía de #1395: «Nuevo contacto» es el primario —la lista
            solo se llenaba con quien escribía o con una planilla— y todo lo de
            mover datos en bloque baja a UN menú: importar y las dos
            exportaciones son del mismo rango, y tres botones hermanos con tres
            pesos se leían como inacabado (#1106, #1118). */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secundario">Importar o exportar</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href="/contactos/importar">
                  <Upload className="mr-2 size-4 text-muted" aria-hidden strokeWidth={1.5} />
                  Importar desde una planilla
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportando || items?.length === 0} onSelect={() => void exportarXlsx()}>
                <Download className="mr-2 size-4 text-muted" aria-hidden strokeWidth={1.5} />
                {exportando ? 'Armando el archivo…' : 'Exportar a Excel'}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportando || items?.length === 0} onSelect={() => void exportar()}>
                <Download className="mr-2 size-4 text-muted" aria-hidden strokeWidth={1.5} />
                Exportar en CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="primario" onClick={() => { setExito(null); setNuevoAbierto(true); }}>
            Nuevo contacto
          </Button>
        </div>
      </div>
      {exito && (
        <AvisoResultado tono="success">
          {exito}
        </AvisoResultado>
      )}
      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
      {items === null ? (
        <>
          {filaDeFiltros('mt-4')}
          <div className="mt-4 flex flex-col gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        </>
      ) : items.length === 0 ? (
        <>
          {filaDeFiltros('mt-4')}
          <EstadoVacio className="mt-6"
            titulo={conFiltros ? 'Nadie con esos filtros' : 'Aquí empieza tu cartera de contactos'}
            descripcion={conFiltros ? 'Prueba con otro canal o permiso, o quítalos para ver a toda la cartera.' : 'Cada persona que escriba aparece aquí con su historia. Si ya tienes una planilla, impórtala para empezar.'}
            accion={conFiltros ? { etiqueta: 'Quitar filtros', onClick: quitarFiltros } : { etiqueta: 'Importar contactos', href: '/contactos/importar' }}
          />
        </>
      ) : (
        <DataTable label="Contactos" columns={columns} rows={items} sorting={sorting}
          onSort={(sort) => { setSorting(sort); firstPage(); }} selection={selection} onSelection={setSelection}
          nextCursor={cursor} loading={loading} mobileColumns={['name']} canPrevious={history.length > 0}
          herramientas={filaDeFiltros()}
          onNext={() => { if (cursor) { setHistory((h) => [...h, currentCursor]); setCurrentCursor(cursor); setSelection({}); } }}
          onPrevious={() => { setCurrentCursor(history.at(-1)); setHistory((h) => h.slice(0, -1)); setSelection({}); }}>
          <EtiquetarSeleccion tenant={tenant} contactIds={items.filter((c) => selection[c.id]).map((c) => c.id)} onDone={() => setSelection({})} />
        </DataTable>
      )}
      <DialogoNuevoContacto
        abierto={nuevoAbierto}
        onCerrar={() => setNuevoAbierto(false)}
        onCreado={(nombre) => {
          setNuevoAbierto(false);
          setExito(nombre ? `${nombre} quedó en tu cartera.` : 'El contacto quedó en tu cartera.');
          // A la primera página: el nuevo contacto es lo que acaba de pasar.
          firstPage();
          void cargar();
        }}
      />
    </div>
  );
}
