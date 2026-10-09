'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, fmtClp } from '../lib/api';
import { SubirPdf } from './conocimiento-pdf';

// Conocimiento (#51, SPEC §14): que la IA responda con lo que el negocio
// DICE. Fuentes con vigencia, catálogo con precio/stock como campos, y la
// búsqueda de prueba muestra la CITA — igual que la verá el cliente.

interface FuenteDto {
  id: string;
  kind: 'texto' | 'pdf' | 'url' | 'faq' | 'catalogo';
  name: string;
  status: 'processing' | 'active' | 'expired' | 'failed';
  error: string | null;
  validUntil: string | null;
  chunkCount?: number;
  createdAt: string;
  /** Cuándo se usó por última vez y cuántas veces (#714). */
  lastUsedAt: string | null;
  useCount: number;
  /** Los `[[enlaces]]` del markdown, con el destino si ya está cargado (#714). */
  enlaces?: Array<{ nombre: string; sourceId: string | null }>;
}

interface ProductoDto {
  sku: string | null;
  name: string;
  price: number | null;
  currency: string;
  stock: number | null;
  description: string | null;
  sourceName: string;
}

interface BusquedaDto {
  hits: Array<{ content: string; sourceName: string; score: number }>;
  cached: boolean;
  expiredSources: string[];
}

const KIND_LABEL: Record<FuenteDto['kind'], string> = {
  texto: 'Texto',
  pdf: 'PDF',
  url: 'Página web',
  faq: 'Preguntas frecuentes',
  catalogo: 'Catálogo (CSV)',
};

const ESTADO: Record<FuenteDto['status'], { label: string; role: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  active: { label: 'Activa', role: 'good' },
  processing: { label: 'Procesando', role: 'neutral' },
  expired: { label: 'Vencida', role: 'warn' },
  failed: { label: 'Falló', role: 'bad' },
};

/**
 * Desde cuándo no se usa, en palabras (#714).
 *
 * «Nunca» va aparte y en tono de aviso: una fuente que nadie usó está pagando
 * indexación y ocupando contexto sin devolver nada, y es la respuesta a la
 * pregunta que nadie podía hacer —«¿cuáles de mis ocho documentos sirven?»—.
 *
 * El resto va en días y no en fecha exacta a propósito: lo que se decide con
 * esto es si sacarla o actualizarla, y para eso «hace 3 meses» dice más que
 * «12-07-2026».
 */
function fmtUso(f: FuenteDto): { texto: string; role: 'good' | 'warn' | 'neutral' } {
  if (!f.lastUsedAt || f.useCount === 0) return { texto: 'Nunca se ha usado', role: 'warn' };
  const dias = Math.floor((Date.now() - new Date(f.lastUsedAt).getTime()) / 86_400_000);
  const cuando = dias <= 0 ? 'hoy' : dias === 1 ? 'ayer' : dias < 30 ? `hace ${dias} días` : `hace ${Math.floor(dias / 30)} meses`;
  const veces = f.useCount === 1 ? '1 vez' : `${f.useCount} veces`;
  return { texto: `Usada ${cuando} · ${veces}`, role: dias < 30 ? 'good' : 'neutral' };
}

const PLACEHOLDER: Record<string, string> = {
  texto: 'Pega aquí lo que la IA debe saber: horarios, políticas, cómo trabajar…',
  faq: 'Una pregunta y respuesta por línea, separadas por "|". Ej:\n¿Hacen despacho? | Sí, a todo Chile en 3-5 días.',
  catalogo: 'Pega el CSV con cabeceras: nombre, precio, stock, descripcion',
  url: '',
};

interface ResumenImportacion {
  importadas: Array<{ nombre: string; enlaces: string[] }>;
  fallidas: Array<{ archivo: string; motivo: string }>;
}

export function Conocimiento() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [fuentes, setFuentes] = useState<FuenteDto[] | null>(null);
  const [kind, setKind] = useState<FuenteDto['kind']>('texto');
  const [nombre, setNombre] = useState('');
  const [contenido, setContenido] = useState('');
  const [url, setUrl] = useState('');
  const [vigencia, setVigencia] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [importando, setImportando] = useState(false);
  const [resumen, setResumen] = useState<ResumenImportacion | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Qué fuente se está reindexando (#447): reindexar dos veces la misma es
  // pagarle dos veces al proveedor de embeddings por lo mismo.
  const [reindexando, setReindexando] = useState<string | null>(null);
  /** Lo que la IA encontraría como PRODUCTO, con precio y stock (#447). */
  const [productos, setProductos] = useState<ProductoDto[] | null>(null);
  const [resultado, setResultado] = useState<BusquedaDto | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setFuentes(await apiFetch<FuenteDto[]>(config, session, tenant, '/knowledge/sources'));
    } catch (err) {
      setAviso((err as Error).message);
      setFuentes([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  /**
   * Trae los .md y los manda en una tanda (#714).
   *
   * Los lee el navegador: son archivos de texto, chicos, y mandarlos por el
   * cuerpo evita el paso de la URL firmada que sí necesita un PDF de 20 MB.
   */
  const importar = async (lista: FileList | null): Promise<void> => {
    if (!session || !lista || lista.length === 0 || importando) return;
    setAviso(null);
    setImportando(true);
    setResumen(null);
    try {
      const archivos = await Promise.all(
        [...lista].map(async (f) => ({ nombre: f.name, contenido: await f.text() })),
      );
      setResumen(
        await apiFetch<ResumenImportacion>(config, session, tenant, '/knowledge/sources/markdown', {
          method: 'POST',
          body: JSON.stringify({ archivos }),
        }),
      );
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setImportando(false);
    }
  };

  const agregar = async () => {
    if (!session) return;
    setAviso(null);
    setGuardando(true);
    try {
      // FAQ: "pregunta | respuesta" por línea → JSON [{q,a}].
      const content =
        kind === 'faq'
          ? JSON.stringify(
              contenido
                .split('\n')
                .map((l) => l.split('|'))
                .filter((p) => p.length >= 2)
                .map(([pq, ...pa]) => ({ q: pq.trim(), a: pa.join('|').trim() })),
            )
          : contenido;
      await apiFetch(config, session, tenant, '/knowledge/sources', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: nombre,
          content: kind === 'url' ? undefined : content,
          url: kind === 'url' ? url : undefined,
          validUntil: vigencia || undefined,
        }),
      });
      setNombre('');
      setContenido('');
      setUrl('');
      setVigencia('');
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async (id: string) => {
    if (!session) return;
    try {
      await apiFetch(config, session, tenant, `/knowledge/sources/${id}`, { method: 'DELETE' });
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  const reindexar = async (id: string) => {
    if (!session || !tenant) return;
    setAviso(null);
    setReindexando(id);
    try {
      await apiFetch(config, session, tenant, `/knowledge/sources/${id}/reindex`, { method: 'POST' });
      await cargar();
    } catch (e) {
      setAviso((e as Error).message);
    } finally {
      setReindexando(null);
    }
  };

  const probar = async () => {
    if (!session || !q.trim()) return;
    setAviso(null);
    try {
      // Las dos cosas que la IA consultaría con esa pregunta, juntas: el
      // pasaje del texto y el PRODUCTO con su precio (#447). Verlas por
      // separado escondía el caso que más importa — cuando la búsqueda
      // encuentra un pasaje que habla del precio y el catálogo tiene otro.
      const [hits, prods] = await Promise.all([
        apiFetch<BusquedaDto>(config, session, tenant, `/knowledge/search?q=${encodeURIComponent(q)}`),
        apiFetch<ProductoDto[]>(
          config,
          session,
          tenant,
          `/knowledge/products?q=${encodeURIComponent(q)}`,
        ).catch(() => []),
      ]);
      setResultado(hits);
      setProductos(prods);
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="max-w-2xl">
      <EncabezadoDePagina
        rotulo="CONOCIMIENTO"
        titulo="Lo que tu negocio dice"
      />
      <p className="mt-2 text-sm text-muted">
        La IA responde SOLO con lo que cargues aquí — y siempre cita la fuente. Los precios y el
        stock del catálogo son datos exactos, nunca inventados. Las fuentes con vigencia vencida
        dejan de usarse solas.
      </p>

      <div className="mt-6 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Agregar fuente</span>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
            <SelectTrigger aria-label="Tipo de fuente" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="texto">Texto</SelectItem>
              <SelectItem value="faq">Preguntas frecuentes</SelectItem>
              <SelectItem value="catalogo">Catálogo (CSV)</SelectItem>
              <SelectItem value="url">Página web</SelectItem>
              <SelectItem value="pdf">PDF (una lista, un menú, tus políticas)</SelectItem>
            </SelectContent>
          </Select>
          <Input
            aria-label="Nombre de la fuente"
            className="w-56"
            placeholder="Ej: Lista de precios sept."
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-body">
            Vence
            <Input
              aria-label="Vigencia"
              type="date"
              className="w-40"
              value={vigencia}
              onChange={(e) => setVigencia(e.target.value)}
            />
          </label>
        </div>
        {kind === 'pdf' ? (
          <div className="mt-3">
            <SubirPdf alTerminar={() => void cargar()} />
          </div>
        ) : kind === 'url' ? (
          <Input
            aria-label="URL"
            className="mt-3"
            placeholder="https://tu-negocio.cl/precios"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        ) : (
          <Textarea
            aria-label="Contenido"
            className="mt-3 font-mono text-sm"
            rows={5}
            placeholder={PLACEHOLDER[kind]}
            value={contenido}
            onChange={(e) => setContenido(e.target.value)}
          />
        )}
        {/* El PDF tiene su propio botón: se sube y se indexa en un paso, así
            que un «Agregar e indexar» al lado sería un botón que no hace nada
            (#522). Antes acá había un texto que decía que la subida directa
            venía «con el onboarding» — ya llegó. */}
        {kind !== 'pdf' && (
          <Button
            className="mt-3"
            disabled={guardando || !nombre.trim() || (kind === 'url' ? !url.trim() : !contenido.trim())}
            onClick={() => void agregar()}
            data-testid="agregar-fuente"
          >
            {guardando ? 'Indexando…' : 'Agregar e indexar'}
          </Button>
        )}
      </div>

      {/* Traer markdown (#714). Sale de «¿sería bueno ponerle obsidian?»:
          Obsidian no encaja —de escritorio, de un usuario, sobre archivos
          locales— pero escribir en markdown y traerlo, sí. */}
      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Traer archivos markdown</span>
        <p className="mt-1 text-sm text-body">
          Escribe donde quieras —Obsidian, el bloc de notas, lo que uses— y trae los{' '}
          <code className="font-mono">.md</code> acá. El nombre sale del{' '}
          <code className="font-mono">title</code>, del primer encabezado o del archivo, en ese
          orden. Los enlaces <code className="font-mono">[[así]]</code> se conservan.
        </p>
        <input
          type="file"
          accept=".md,.markdown,text/markdown"
          multiple
          className="mt-3 block w-full text-sm"
          disabled={importando}
          onChange={(e) => void importar(e.target.files)}
          aria-label="Archivos markdown"
        />
        {importando && <p className="ayuda mt-2">Indexando lo que llegó…</p>}
        {resumen && (
          <p className="mt-2 text-sm text-body">
            {resumen.importadas.length > 0 &&
              `Entraron ${resumen.importadas.length}: ${resumen.importadas.map((i) => i.nombre).join(', ')}.`}
            {resumen.fallidas.length > 0 && (
              <>
                {' '}
                {/* Se nombra cuál falló: «3 de 40 fallaron» obliga a revisarlos
                    todos a mano. */}
                No entraron {resumen.fallidas.length}:{' '}
                {resumen.fallidas.map((f) => `${f.archivo} (${f.motivo})`).join('; ')}
              </>
            )}
          </p>
        )}
      </div>

      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Fuentes</span>
        {fuentes === null ? (
          <Skeleton className="mt-3 h-20" />
        ) : fuentes.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Aún no hay fuentes. La IA solo conoce la conversación.</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {fuentes.map((f) => {
              const uso = fmtUso(f);
              return (
              <li key={f.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink">{f.name}</p>
                  <p className="dato text-muted">
                    {KIND_LABEL[f.kind]}
                    {f.chunkCount !== undefined && f.chunkCount > 0 && ` · ${f.chunkCount} pasajes`}
                    {f.validUntil && ` · vence ${new Date(f.validUntil).toLocaleDateString('es-CL')}`}
                    {f.error && ` · ${f.error}`}
                  </p>
                  {/* El uso (#714): una fuente que sostiene la mitad de las
                      respuestas y una que nadie usó nunca se veían idénticas.
                      Va como etiqueta y no solo con color, que es la regla de
                      Pulso: el color nunca es el único portador. */}
                  <p className="mt-1">
                    <Badge role={uso.role}>{uso.texto}</Badge>
                  </p>
                  {/* Los `[[enlaces]]` del documento. El que todavía no tiene
                      destino se muestra igual y se dice: es un documento que
                      falta, no un error. */}
                  {f.enlaces !== undefined && f.enlaces.length > 0 && (
                    <p className="mt-1 text-xs text-muted">
                      Enlaza a{' '}
                      {f.enlaces.map((e, i) => (
                        <span key={e.nombre}>
                          {i > 0 && ', '}
                          <span className={e.sourceId ? 'text-action-text' : 'text-warn-text'}>
                            {e.nombre}
                            {!e.sourceId && ' (sin cargar)'}
                          </span>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
                <Badge role={ESTADO[f.status].role}>{ESTADO[f.status].label}</Badge>
                {/* Reindexar (#447): la ruta existía y no la llamaba nadie,
                    así que una fuente que falló o que venció solo se podía
                    arreglar borrándola y volviendo a subirla — perdiendo
                    su historial. Se ofrece donde tiene sentido: en la que
                    no está sirviendo. */}
                {(f.status === 'failed' || f.status === 'expired') && (
                  <Button
                    variant="secundario"
                    size="chico"
                    disabled={reindexando === f.id}
                    onClick={() => void reindexar(f.id)}
                  >
                    {reindexando === f.id ? 'Reindexando…' : 'Reindexar'}
                  </Button>
                )}
                <Button variant="fantasma" size="chico" onClick={() => void eliminar(f.id)}>
                  Eliminar
                </Button>
              </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Prueba qué encontraría la IA</span>
        <div className="mt-3 flex gap-2">
          <Input
            aria-label="Pregunta de prueba"
            placeholder="Ej: ¿cuánto cuesta la manicure?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void probar()}
          />
          <Button variant="secundario" onClick={() => void probar()}>Probar</Button>
        </div>
        {/* El catálogo primero: si la pregunta toca un producto, el precio
            exacto manda sobre cualquier pasaje de texto que lo mencione. */}
        {productos !== null && productos.length > 0 && (
          <div className="mt-3">
            <p className="rotulo">Del catálogo, con precio exacto</p>
            <ul className="mt-2 flex flex-col gap-2">
              {productos.map((p) => (
                <li key={`${p.sku ?? p.name}`} className="rounded-campo border border-line bg-bg p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-ink">{p.name}</span>
                    <span className="dato text-ink">
                      {p.price === null ? 'sin precio' : fmtClp(p.price)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {p.sku ? `SKU ${p.sku} · ` : ''}
                    {p.stock === null ? 'sin stock declarado' : `${p.stock} en stock`} · {p.sourceName}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {resultado && (
          <div className="mt-3">
            {resultado.expiredSources.length > 0 && (
              <p className="mb-2 rounded-campo border border-warn-soft-br bg-warn-soft px-3 py-2 text-sm text-warn-text">
                Fuentes vencidas que la IA ya no usa: {resultado.expiredSources.join(', ')}.
              </p>
            )}
            {resultado.hits.length === 0 ? (
              <p className="text-sm text-muted">Nada por aquí: con esto la IA diría que no lo sabe (o escalaría).</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {resultado.hits.map((h, i) => (
                  <li key={i} className="rounded-campo border border-line bg-bg p-3 text-sm">
                    <p className="text-body">{h.content}</p>
                    <p className="dato mt-1 text-muted">según {h.sourceName} · afinidad {(h.score * 100).toFixed(0)} %</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
    </div>
  );
}
