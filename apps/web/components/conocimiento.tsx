'use client';

import { AvisoResultado } from '@iaxti/ui/react';

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
import { apiFetch } from '../lib/api';

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

const PLACEHOLDER: Record<string, string> = {
  texto: 'Pega aquí lo que la IA debe saber: horarios, políticas, cómo trabajar…',
  faq: 'Una pregunta y respuesta por línea, separadas por "|". Ej:\n¿Hacen despacho? | Sí, a todo Chile en 3-5 días.',
  catalogo: 'Pega el CSV con cabeceras: nombre, precio, stock, descripcion',
  url: '',
};

export function Conocimiento() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [fuentes, setFuentes] = useState<FuenteDto[] | null>(null);
  const [kind, setKind] = useState<'texto' | 'url' | 'faq' | 'catalogo'>('texto');
  const [nombre, setNombre] = useState('');
  const [contenido, setContenido] = useState('');
  const [url, setUrl] = useState('');
  const [vigencia, setVigencia] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [q, setQ] = useState('');
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

  const probar = async () => {
    if (!session || !q.trim()) return;
    setAviso(null);
    try {
      setResultado(
        await apiFetch<BusquedaDto>(config, session, tenant, `/knowledge/search?q=${encodeURIComponent(q)}`),
      );
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="max-w-2xl">
      <p className="rotulo">Conocimiento</p>
      <h1 className="mt-1 font-display text-titulo font-bold text-ink">Lo que tu negocio dice</h1>
      <p className="mt-2 text-sm text-muted">
        La IA responde SOLO con lo que cargues aquí — y siempre cita la fuente. Los precios y el
        stock del catálogo son datos exactos, nunca inventados. Las fuentes con vigencia vencida
        dejan de usarse solas.
      </p>

      <div className="mt-6 rounded-tarjeta border border-line bg-raised p-6">
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
        {kind === 'url' ? (
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
        <Button
          className="mt-3"
          disabled={guardando || !nombre.trim() || (kind === 'url' ? !url.trim() : !contenido.trim())}
          onClick={() => void agregar()}
          data-testid="agregar-fuente"
        >
          {guardando ? 'Indexando…' : 'Agregar e indexar'}
        </Button>
        <p className="mt-2 text-sm text-muted">
          ¿Tienes un PDF? Por ahora pega su contenido como texto — la subida directa viene con el
          onboarding.
        </p>
      </div>

      <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Fuentes</span>
        {fuentes === null ? (
          <Skeleton className="mt-3 h-20" />
        ) : fuentes.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Aún no hay fuentes. La IA solo conoce la conversación.</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {fuentes.map((f) => (
              <li key={f.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink">{f.name}</p>
                  <p className="dato text-muted">
                    {KIND_LABEL[f.kind]}
                    {f.chunkCount !== undefined && f.chunkCount > 0 && ` · ${f.chunkCount} pasajes`}
                    {f.validUntil && ` · vence ${new Date(f.validUntil).toLocaleDateString('es-CL')}`}
                    {f.error && ` · ${f.error}`}
                  </p>
                </div>
                <Badge role={ESTADO[f.status].role}>{ESTADO[f.status].label}</Badge>
                <Button variant="fantasma" size="chico" onClick={() => void eliminar(f.id)}>
                  Eliminar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
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
