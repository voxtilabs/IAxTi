'use client';

import { useState } from 'react';
import { Badge, Button, Textarea, useSession } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch } from '../../lib/api';

// Importación CSV (#34, SPEC §10): mapeo de columnas, validación fila por
// fila con el formato único de errores, y NADA se escribe hasta confirmar.
// Los importados nacen sin opt-in.

interface FilaPreview {
  fila: number;
  ok: boolean;
  data?: { phone: string; name?: string; email?: string; rut?: string };
  errores: Array<{ field: string; message: string }>;
  duplicadoEnArchivo: boolean;
  yaExiste: boolean;
}

interface Preview {
  headers: string[];
  mapping: Record<number, string>;
  rows: FilaPreview[];
  validas: number;
}

const CAMPOS = [
  { value: '', label: '(ignorar)' },
  { value: 'phone', label: 'Teléfono' },
  { value: 'name', label: 'Nombre' },
  { value: 'email', label: 'Correo' },
  { value: 'rut', label: 'RUT' },
];

export function Importar() {
  const { session, config } = useSession();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [resultado, setResultado] = useState<{ created: number; skipped: number } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const tenant = typeof window !== 'undefined' ? selectedTenant() : null;

  async function api<T>(path: string, body: unknown): Promise<T> {
    if (!session || !tenant) throw new Error('Elige un negocio en el selector.');
    return apiFetch<T>(config, session, tenant, path, { method: 'POST', body: JSON.stringify(body) });
  }

  async function verPrevia(mapping?: Record<number, string>) {
    setAviso(null);
    setResultado(null);
    setTrabajando(true);
    try {
      setPreview(await api<Preview>('/contacts/import/preview', { csv, mapping }));
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setTrabajando(false);
    }
  }

  async function confirmar() {
    if (!preview) return;
    setTrabajando(true);
    setAviso(null);
    try {
      setResultado(await api('/contacts/import/confirm', { csv, mapping: preview.mapping }));
      setPreview(null);
      setCsv('');
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="rotulo">Contactos</p>
      <h1 className="mt-1 font-display text-xl font-bold text-ink">Importar desde una planilla</h1>
      <p className="mt-2 max-w-prose text-body">
        Exporta tu Excel como CSV y pégalo aquí (o súbelo). Antes de guardar nada te mostramos
        fila por fila qué entra y qué necesita arreglo. Los importados nacen <strong>sin
        consentimiento de contacto</strong>: podrás escribirles cuando ellos escriban primero o
        registres su opt-in.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Archivo CSV"
          className="text-sm text-body file:mr-3 file:rounded-boton file:border file:border-line-strong file:bg-transparent file:px-4 file:py-1.5 file:text-sm file:text-ink"
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            if (!archivo) return;
            void archivo.text().then(setCsv);
          }}
        />
        <Textarea
          aria-label="Contenido CSV"
          placeholder={'nombre;telefono;rut\nMaría Paz;+56 9 1234 5678;11.111.111-1'}
          rows={6}
          className="dato text-sm"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <div>
          <Button onClick={() => void verPrevia()} disabled={!csv.trim() || trabajando}>
            {trabajando ? 'Revisando…' : 'Ver la vista previa'}
          </Button>
        </div>
      </div>

      {aviso && (
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          {aviso}
        </p>
      )}

      {resultado && (
        <p role="status" className="mt-4 rounded-campo border border-good-soft-br bg-good-soft px-4 py-3 text-sm text-good-text">
          Listo: {resultado.created} contactos creados, {resultado.skipped} filas saltadas.
        </p>
      )}

      {preview && (
        <div className="mt-8">
          <h2 className="text-lg font-bold text-ink">Vista previa</h2>
          <p className="mt-1 text-sm text-muted">
            Ajusta a qué campo va cada columna si adivinamos mal. Nada se guarda todavía.
          </p>
          <div className="mt-3 overflow-x-auto rounded-tarjeta border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-rest">
                  <th className="rotulo px-3 py-2 text-left">Fila</th>
                  {preview.headers.map((h, i) => (
                    <th key={i} className="px-3 py-2 text-left">
                      <span className="block truncate text-xs text-muted">{h}</span>
                      <select
                        aria-label={`Campo para la columna ${h}`}
                        className="mt-1 h-8 rounded-campo border border-line-strong bg-field px-2 text-xs text-ink"
                        value={preview.mapping[i] ?? ''}
                        onChange={(e) => {
                          const mapping = { ...preview.mapping };
                          if (e.target.value) mapping[i] = e.target.value;
                          else delete mapping[i];
                          void verPrevia(mapping);
                        }}
                      >
                        {CAMPOS.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-left">Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 50).map((fila) => (
                  <tr key={fila.fila} className="border-t border-line">
                    <td className="dato px-3 py-2 text-muted">{fila.fila}</td>
                    {preview.headers.map((_, i) => (
                      <td key={i} className="max-w-40 truncate px-3 py-2 text-body">
                        {fila.data && preview.mapping[i]
                          ? (fila.data[preview.mapping[i] as keyof typeof fila.data] ?? '')
                          : ''}
                      </td>
                    ))}
                    <td className="px-3 py-2">
                      {fila.yaExiste ? (
                        <Badge role="neutral">Ya existe</Badge>
                      ) : fila.duplicadoEnArchivo ? (
                        <Badge role="warn">Repetida en el archivo</Badge>
                      ) : fila.ok ? (
                        <Badge role="good">Lista</Badge>
                      ) : (
                        fila.errores.map((e) => (
                          <span key={e.field} className="block text-xs text-bad-text">
                            {e.message}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 50 && (
            <p className="mt-2 text-xs text-muted">
              Mostrando 50 de {preview.rows.length} filas; la validación corrió sobre todas.
            </p>
          )}
          <div className="mt-4 flex items-center gap-4">
            <Button onClick={() => void confirmar()} disabled={preview.validas === 0 || trabajando}>
              Importar {preview.validas} contactos
            </Button>
            <span className="text-sm text-muted">
              {preview.rows.length - preview.validas} filas quedan fuera (errores o repetidas).
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
