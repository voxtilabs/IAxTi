'use client';

import { AvisoResultado } from './ui/avisos';

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
  const [cadena, setCadena] = useState<ChainCheckDto | null>(null);
  const [firma, setFirma] = useState<SignedExportDto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const limpios = useCallback(
    () => Object.fromEntries(Object.entries(filtros).filter(([, v]) => v.trim())),
    [filtros],
  );

  const buscar = useCallback(() => {
    setCargando(true);
    setAviso(null);
    fetcher
      .search(limpios())
      .then(setFilas)
      .catch((err: Error) => setAviso(err.message))
      .finally(() => setCargando(false));
  }, [fetcher, limpios]);

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
            {(filas ?? []).map((f) => (
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
        {filas !== null && filas.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted">No hay entradas con esos filtros.</p>
        )}
      </div>
    </div>
  );
}
