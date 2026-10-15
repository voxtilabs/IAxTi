'use client';

import { AvisoResultado } from './ui/avisos';
import { EstadoVacio } from './estado-vacio';
import { Skeleton } from './ui/skeleton';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';

// El explorador del libro de auditoría (#72, SPEC §13). EL MISMO componente
// para el SuperAdmin (todos los tenants) y para el ADMIN de un tenant: lo
// único que cambia es el fetcher que le pasan y el filtro por tenant.

export interface AuditRow {
  id: number | string;
  tenant_id?: string;
  actor: string;
  actor_kind: string;
  action: string;
  resource: string | null;
  resource_id?: string | null;
  result: string | null;
  ip?: string | null;
  occurred_at: string;
}

export interface ChainCheckDto {
  valid: boolean;
  entries: number;
  brokenAtId?: number | null;
}

export interface SignedExportDto {
  format: string;
  sha256: string;
  signature: string | null;
  rows: number;
  payload: string;
}

export interface AuditFetcher {
  search(params: Record<string, string>): Promise<AuditRow[]>;
  /**
   * La misma búsqueda, con el cursor de la página siguiente (#799).
   *
   * Opcional porque el explorador se usa en dos lados y el `search` de
   * siempre sigue siendo válido: sin esto, no hay «ver más» y se ve lo mismo
   * que antes. Con esto, el libro deja de cortarse en cien sin decirlo.
   */
  searchPaginado?(
    params: Record<string, string>,
  ): Promise<{ entries: AuditRow[]; nextCursor: string | null }>;
  verify(tenantId?: string): Promise<ChainCheckDto>;
  exportar(format: 'csv' | 'json', params: Record<string, string>): Promise<SignedExportDto>;
  /** Solo el explorador global trae el filtro por tenant. */
  global?: boolean;
}

const CAMPOS = [
  { name: 'actor', label: 'Actor' },
  { name: 'actorKind', label: 'Tipo de actor' },
  { name: 'action', label: 'Acción' },
  { name: 'resource', label: 'Recurso' },
  { name: 'result', label: 'Resultado' },
  { name: 'ip', label: 'IP' },
  { name: 'from', label: 'Desde (AAAA-MM-DD)' },
  { name: 'to', label: 'Hasta (AAAA-MM-DD)' },
];

const TIPO_ACTOR: Record<string, string> = {
  user: 'Persona',
  agent: 'Agente',
  system: 'Sistema',
  apikey: 'API key',
  superadmin: 'SuperAdmin',
};

export function AuditExplorer({ fetcher }: { fetcher: AuditFetcher }) {
  const [filtros, setFiltros] = useState<Record<string, string>>({});
  const [filas, setFilas] = useState<AuditRow[] | null>(null);
  /** Desde dónde sigue; `null` es «no hay más» y `undefined` «todavía no sé». */
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [trayendoMas, setTrayendoMas] = useState(false);
  const [cadena, setCadena] = useState<ChainCheckDto | null>(null);
  const [firma, setFirma] = useState<SignedExportDto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const limpios = useCallback(
    () => Object.fromEntries(Object.entries(filtros).filter(([, v]) => v.trim())),
    [filtros],
  );

  /**
   * Una búsqueda, por el camino paginado si el fetcher lo tiene.
   *
   * El `cursor: ''` no sobra: la ruta devuelve la forma nueva solo cuando el
   * parámetro está PRESENTE, y en la primera página todavía no hay desde
   * dónde seguir. Mandarlo vacío es cómo se pide la primera.
   */
  const traer = useCallback(
    async (params: Record<string, string>) => {
      if (!fetcher.searchPaginado) {
        setSiguiente(null);
        return fetcher.search(params);
      }
      const r = await fetcher.searchPaginado({ ...params, cursor: '' });
      setSiguiente(r.nextCursor);
      return r.entries;
    },
    [fetcher],
  );

  const buscar = useCallback(() => {
    setCargando(true);
    setAviso(null);
    traer(limpios())
      .then(setFilas)
      .catch((err: Error) => setAviso(err.message))
      .finally(() => setCargando(false));
  }, [traer, limpios]);

  /**
   * La página siguiente se AGREGA abajo, no reemplaza.
   *
   * Reemplazar obligaría a volver atrás para releer lo de arriba, y acá se
   * está siguiendo el rastro de un hecho: lo que se lee es la secuencia.
   */
  const verMas = useCallback(() => {
    if (!fetcher.searchPaginado || !siguiente) return;
    setTrayendoMas(true);
    setAviso(null);
    fetcher
      .searchPaginado({ ...limpios(), cursor: siguiente })
      .then((r) => {
        setFilas((previas) => [...(previas ?? []), ...r.entries]);
        setSiguiente(r.nextCursor);
      })
      .catch((err: Error) => setAviso(err.message))
      .finally(() => setTrayendoMas(false));
  }, [fetcher, limpios, siguiente]);

  /**
   * La accion del estado vacio: quitar los filtros y volver a buscar (#588).
   *
   * Un estado vacio que solo dice «no hay nada» es un callejon, y la regla de
   * Pulso pide la accion que lo provoca. Aca la accion correcta es la que
   * deshace lo unico que pudo esconder las filas: los filtros.
   *
   * Y no se limpia sin buscar: dejar los campos en blanco y la tabla igual
   * seria pedirle a la persona que adivine que ahora tiene que apretar Buscar.
   */
  const limpiarYBuscar = useCallback(() => {
    setFiltros({});
    setCargando(true);
    setAviso(null);
    traer({})
      .then(setFilas)
      .catch((err: Error) => setAviso(err.message))
      .finally(() => setCargando(false));
  }, [traer]);

  // Primera carga sin filtros: el libro se abre en la última página escrita.
  // Solo al montar — después manda el botón, no cada tecla del filtro.
  const [cargadoUnaVez, setCargadoUnaVez] = useState(false);
  useEffect(() => {
    if (cargadoUnaVez) return;
    setCargadoUnaVez(true);
    buscar();
  }, [cargadoUnaVez, buscar]);

  const campos = fetcher.global
    ? [{ name: 'tenantId', label: 'Tenant (uuid)' }, ...CAMPOS]
    : CAMPOS;

  const correrVerify = () => {
    setAviso(null);
    fetcher
      .verify(filtros.tenantId)
      .then(setCadena)
      .catch((err: Error) => setAviso(err.message));
  };

  return (
    <div>
      <div className="pulso-panel rounded-tarjeta border border-line bg-raised p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {campos.map((c) => (
            <Input
              key={c.name}
              aria-label={c.label}
              placeholder={c.label}
              value={filtros[c.name] ?? ''}
              onChange={(e) => setFiltros({ ...filtros, [c.name]: e.target.value })}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={buscar} disabled={cargando}>
            {cargando ? 'Buscando…' : 'Buscar'}
          </Button>
          <Button variant="secundario" onClick={correrVerify}>
            Verificar cadena
          </Button>
          {(['csv', 'json'] as const).map((f) => (
            <Button
              key={f}
              variant="secundario"
              onClick={() =>
                void fetcher
                  .exportar(f, limpios())
                  .then(setFirma)
                  .catch((err: Error) => setAviso(err.message))
              }
            >
              Exportar {f.toUpperCase()}
            </Button>
          ))}
        </div>

        {cadena && (
          <div
            className={`mt-3 rounded-campo border px-3 py-2 text-sm ${
              cadena.valid
                ? 'border-good-soft-br bg-good-soft text-good-text'
                : 'border-bad-soft-br bg-bad-soft text-bad-text'
            }`}
          >
            {cadena.valid
              ? `Cadena íntegra: ${cadena.entries} entradas encadenadas sin un solo hueco.`
              : `Cadena ROTA en la entrada ${cadena.brokenAtId}. Alguien tocó el libro por debajo.`}
          </div>
        )}

        {firma && (
          <div className="mt-3 rounded-campo border border-line bg-bg p-3">
            <p className="rotulo">
              Export {firma.format.toUpperCase()} · {firma.rows} filas
            </p>
            <p className="dato mt-1 break-all text-xs text-muted">sha256: {firma.sha256}</p>
            <p className="dato break-all text-xs text-muted">
              firma:{' '}
              {firma.signature ?? (
                <span className="text-warn-text">
                  sin firmar — al servidor le falta AUDIT_EXPORT_SECRET
                </span>
              )}
            </p>
            <textarea
              readOnly
              aria-label="Contenido exportado"
              className="dato mt-2 h-32 w-full rounded-campo border border-line bg-raised p-2 text-xs text-body"
              value={firma.payload}
            />
          </div>
        )}

        {aviso && (
          <AvisoResultado>
            {aviso}
          </AvisoResultado>
        )}
      </div>

      <div className="mt-4 overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-line bg-rest text-left">
              {['Cuándo', ...(fetcher.global ? ['Tenant'] : []), 'Actor', 'Tipo', 'Acción', 'Recurso', 'IP', 'Resultado'].map(
                (h) => (
                  <th key={h} className="rotulo px-3 py-2 font-normal">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {/*
              Mientras busca NO se muestran las filas viejas (#588).

              Lo normal en una tabla es dejar el resultado anterior puesto
              mientras llega el nuevo, y acá eso es peor: las filas que se ven
              NO coinciden con los filtros que la persona acaba de escribir.
              En un libro de auditoría, mostrar registros que no corresponden
              a lo que se preguntó no es un detalle de estilo — es una
              respuesta equivocada a una pregunta concreta, y alguien puede
              concluir que algo pasó, o que no pasó, mirando filas de otra
              consulta.

              Así que durante la búsqueda manda el esqueleto de abajo, que no
              afirma nada.
            */}
            {(cargando ? [] : filas ?? []).map((f) => (
              <tr key={String(f.id)} className="border-b border-line last:border-0">
                <td className="dato whitespace-nowrap px-3 py-2 text-xs text-muted">
                  {new Date(f.occurred_at).toLocaleString('es-CL')}
                </td>
                {fetcher.global && (
                  <td className="dato px-3 py-2 text-xs text-faint">
                    {String(f.tenant_id ?? '').slice(0, 8)}
                  </td>
                )}
                <td className="dato px-3 py-2 text-xs text-body">{f.actor.slice(0, 13)}</td>
                <td className="px-3 py-2 text-xs text-body">
                  {TIPO_ACTOR[f.actor_kind] ?? f.actor_kind}
                </td>
                <td className="dato px-3 py-2 text-xs text-ink">{f.action}</td>
                <td className="dato px-3 py-2 text-xs text-muted">
                  {f.resource}
                  {f.resource_id ? ` · ${String(f.resource_id).slice(0, 8)}` : ''}
                </td>
                <td className="dato px-3 py-2 text-xs text-muted">{f.ip ?? '—'}</td>
                <td className="px-3 py-2 text-xs">
                  {f.result ? (
                    <Badge role={f.result === 'ok' ? 'good' : 'bad'}>{f.result}</Badge>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/*
          Tres pixeles distintos para tres cosas distintas (#588).

          Antes había uno: la tabla en blanco servía para «cargando», para
          «no busqué todavía» y para «no hay nada». El issue lo anotó así —
          «es la pantalla donde alguien va a buscar qué pasó, y no distingue
          no hay registros de no cargó»— y la excepción de la guarda lo decía
          con más precisión: «el mismo pixel sirve para buscando y para no hay
          nada».

          Y eso duele acá más que en otras pantallas: el libro de auditoría es
          donde alguien entra cuando algo pasó y necesita saber qué. Una tabla
          vacía que puede significar «nadie hizo nada» o «no cargó» no sirve
          para decidir nada, y en la segunda lectura es peor que un error:
          parece una respuesta.

          `filas === null` es solo la primera carga, porque el `useEffect` de
          arriba busca al abrir. Así que no hay estado «todavía no buscaste».
        */}
        {cargando && (
          <div aria-busy="true" aria-label="Buscando en el libro de auditoría" className="flex flex-col gap-2 px-3 py-3">
            {/*
              Del alto de una fila de verdad, y cinco, que es lo que se ve en
              una pantalla. Un esqueleto más corto que el contenido hace que la
              página brinque cuando llegan los datos — el punto 3 de #588.
            */}
            {[0, 1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-8 w-full" />
            ))}
          </div>
        )}
        {!cargando && filas !== null && filas.length === 0 && (
          <EstadoVacio
            compacto
            className="m-3"
            titulo="No hay nada registrado con esos filtros"
            descripcion={
              'El libro guarda cada acción importante con quién, cuándo y desde dónde. Si esperabas ' +
              'ver algo, prueba con un rango de fechas más amplio o quita algún filtro: lo que no ' +
              'coincide no aparece, y el libro no se puede editar ni borrar.'
            }
            accion={{ etiqueta: 'Buscar sin filtros', onClick: limpiarYBuscar }}
          />
        )}
        {/* Cuántas se están viendo, y cómo traer más (#799).
            El conteo va SIEMPRE que haya filas, no solo cuando falta página:
            «100 entradas» sin más contexto es justo lo que hacía creer que el
            libro tenía cien y nada más. */}
        {!cargando && filas !== null && filas.length > 0 && (
          <p className="flex flex-wrap items-center gap-3 border-t border-line p-3 text-sm text-muted">
            <span>
              {filas.length === 1 ? '1 entrada' : `${filas.length} entradas`}
              {siguiente ? ' — hay más' : ''}
            </span>
            {siguiente && (
              <Button variant="fantasma" size="chico" onClick={verMas} disabled={trayendoMas}>
                {trayendoMas ? 'Trayendo…' : 'Ver más'}
              </Button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
