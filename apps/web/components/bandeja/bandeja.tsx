'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Badge,
  IconoReloj,
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
  type BusquedaHit,
  type ConversacionDetalle,
  type ConversacionItem,
  type Mensaje,
  type AnalisisDto,
  type NotaDto,
  type QuickReplyDto,
  type SugerenciaDto,
} from '../../lib/api';
import { Chat } from './chat';
import { Ficha } from './ficha';
import { ESTADOS, fmtEspera } from './estado';

// La bandeja de tres paneles (SPEC §11/§29, #37): lista sobre --bg-raised,
// chat sobre --bg, ficha sobre --bg-raised. En celular, tres pantallas
// apiladas navegables. Realtime por broadcast: el socket avisa (solo ids)
// y el cliente refresca por la API con sus permisos.

type Vista = 'todas' | 'mi_cola' | 'sin_responder';
type Pane = 'lista' | 'chat' | 'ficha';

export function Bandeja() {
  const { supabase, session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista>('todas');
  const [items, setItems] = useState<ConversacionItem[] | null>(null);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<ConversacionDetalle | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[] | null>(null);
  const [pane, setPane] = useState<Pane>('lista');
  const [aviso, setAviso] = useState<string | null>(null);
  const [atajos, setAtajos] = useState<QuickReplyDto[]>([]);
  const [notas, setNotas] = useState<NotaDto[]>([]);
  const [sugerencia, setSugerencia] = useState<SugerenciaDto | null>(null);
  const [analisis, setAnalisis] = useState<AnalisisDto | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [hits, setHits] = useState<BusquedaHit[] | null>(null);
  const seleccionRef = useRef<string | null>(null);
  seleccionRef.current = seleccion;

  // El tenant del selector del shell (localStorage) — mismo mecanismo.
  useEffect(() => {
    setTenant(selectedTenant());
    const onStorage = () => setTenant(selectedTenant());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const cargarLista = useCallback(async () => {
    if (!session || !tenant) return;
    const query = vista === 'todas' ? '' : `?view=${vista}`;
    try {
      const res = await apiFetch<{ items: ConversacionItem[] }>(
        config, session, tenant, `/conversations${query}`,
      );
      setItems(res.items);
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant, vista]);

  const cargarConversacion = useCallback(
    async (id: string) => {
      if (!session || !tenant) return;
      try {
        const [d, m, n, sug, ana] = await Promise.all([
          apiFetch<ConversacionDetalle>(config, session, tenant, `/conversations/${id}`),
          apiFetch<Mensaje[]>(config, session, tenant, `/conversations/${id}/messages`),
          apiFetch<NotaDto[]>(config, session, tenant, `/conversations/${id}/notes`),
          // agents puede estar apagado: el copiloto simplemente no aparece.
          apiFetch<SugerenciaDto | null>(config, session, tenant, `/conversations/${id}/suggestion`).catch(() => null),
          apiFetch<AnalisisDto>(config, session, tenant, `/conversations/${id}/analisis`).catch(() => null),
        ]);
        setDetalle(d);
        setMensajes(m);
        setNotas(n);
        setSugerencia(sug);
        setAnalisis(ana);
      } catch (err) {
        setAviso((err as Error).message);
      }
    },
    [config, session, tenant],
  );

  useEffect(() => void cargarLista(), [cargarLista]);
  // Los atajos del negocio + los míos, una vez por tenant.
  useEffect(() => {
    if (!session || !tenant) return;
    void apiFetch<QuickReplyDto[]>(config, session, tenant, '/quick-replies')
      .then(setAtajos)
      .catch(() => setAtajos([]));
  }, [config, session, tenant]);
  useEffect(() => {
    if (seleccion) void cargarConversacion(seleccion);
  }, [seleccion, cargarConversacion]);

  // Realtime por broadcast (SPEC §40): canal privado del tenant; cualquier
  // evento refresca la lista, y la conversación abierta si es la suya.
  useEffect(() => {
    if (!session || !tenant) return;
    supabase.realtime.setAuth(session.access_token);
    const canal = supabase
      .channel(`tenant:${tenant}:bandeja`, { config: { private: true } })
      .on('broadcast', { event: '*' }, (msg) => {
        void cargarLista();
        const payload = msg.payload as { conversationId?: string } | undefined;
        if (payload?.conversationId && payload.conversationId === seleccionRef.current) {
          void cargarConversacion(payload.conversationId);
        }
      });
    canal.subscribe();
    return () => void supabase.removeChannel(canal);
  }, [supabase, session, tenant, cargarLista, cargarConversacion]);

  async function accion(path: string, body: unknown): Promise<void> {
    if (!session || !tenant || !seleccion) return;
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, `/conversations/${seleccion}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await Promise.all([cargarConversacion(seleccion), cargarLista()]);
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  async function buscar(q: string): Promise<void> {
    if (!session || !tenant) return;
    if (!q.trim()) {
      setHits(null);
      return;
    }
    try {
      setHits(await apiFetch<BusquedaHit[]>(config, session, tenant, `/search?q=${encodeURIComponent(q)}`));
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  if (!tenant) {
    return <p className="p-8 text-muted">Elige un negocio en el selector para ver su bandeja.</p>;
  }

  const miId = session?.user?.id ?? '';

  return (
    <div className="flex h-[calc(100vh-73px)] overflow-hidden">
      {/* Panel 1 · Lista (--bg-raised) */}
      <section
        aria-label="Conversaciones"
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-r border-line bg-raised md:flex md:w-80',
          pane === 'lista' ? 'flex' : 'hidden',
        )}
      >
        <div className="sticky top-0 z-10 border-b border-line bg-raised p-4">
          <h1 className="font-display text-lg font-bold text-ink">Bandeja</h1>
          <Tabs value={vista} onValueChange={(v) => setVista(v as Vista)} className="mt-3">
            <TabsList className="w-full">
              <TabsTrigger value="todas" className="flex-1">Todas</TabsTrigger>
              <TabsTrigger value="mi_cola" className="flex-1">Mi cola</TabsTrigger>
              <TabsTrigger value="sin_responder" className="flex-1">Sin responder</TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            type="search"
            aria-label="Buscar en mensajes y notas"
            placeholder="Buscar en mensajes y notas…"
            className="mt-3 h-9 text-sm"
            value={busqueda}
            onChange={(e) => {
              setBusqueda(e.target.value);
              if (!e.target.value.trim()) setHits(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void buscar(busqueda);
            }}
          />
        </div>
        {hits !== null && (
          <div className="border-b border-line">
            <p className="rotulo px-4 pt-3">Resultados</p>
            {hits.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted">Nada con “{busqueda}”.</p>
            )}
            <ul>
              {hits.map((h, i) => (
                <li key={`${h.kind}-${i}`}>
                  <button
                    type="button"
                    className="w-full px-4 py-2 text-left transition-colors hover:bg-rest"
                    onClick={() => {
                      setSeleccion(h.conversationId);
                      setPane('chat');
                      setHits(null);
                      setBusqueda('');
                    }}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">
                      {h.contactName ?? h.contactPhone}
                      {h.kind === 'nota' && <Badge role="warn">Nota</Badge>}
                    </span>
                    <span
                      className="block truncate text-xs text-muted [&_b]:text-action-text"
                      dangerouslySetInnerHTML={{ __html: h.snippet }}
                    />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {aviso && !detalle && (
          <p role="alert" className="m-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-2 text-sm text-warn-text">
            {aviso}
          </p>
        )}
        {items === null ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-sm text-muted">
            Nada por aquí. Cuando llegue un mensaje, la conversación aparece sola.
          </p>
        ) : (
          <ul className="flex flex-col">
            {items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => { setSeleccion(c.id); setPane('chat'); }}
                  className={cn(
                    'flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition-colors hover:bg-rest',
                    seleccion === c.id && 'bg-rest',
                  )}
                >
                  <Avatar nombre={c.contactName} fallback={c.contactPhone} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">
                      {c.contactName ?? c.contactPhone}
                    </span>
                    <span className="dato block text-muted">{c.contactPhone}</span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <Badge role={ESTADOS[c.state].role}>{ESTADOS[c.state].label}</Badge>
                    {c.unansweredSeconds !== null && (
                      <span className="dato flex items-center gap-1 text-warn-text">
                        <IconoReloj className="h-3 w-3" />
                        {fmtEspera(c.unansweredSeconds)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Panel 2 · Chat (--bg) */}
      <section
        aria-label="Conversación"
        className={cn(
          'min-w-0 flex-1 flex-col bg-bg md:flex',
          pane === 'chat' ? 'flex' : 'hidden',
        )}
      >
        <Chat
          detalle={detalle}
          mensajes={mensajes}
          atajos={atajos}
          sugerencia={sugerencia}
          miId={miId}
          aviso={aviso}
          onSugerencia={async (accion, extra) => {
            if (!session || !tenant || !seleccion || !sugerencia) return;
            setAviso(null);
            try {
              await apiFetch(
                config, session, tenant,
                `/conversations/${seleccion}/suggestions/${sugerencia.id}/${accion}`,
                { method: 'POST', body: JSON.stringify(extra ?? {}) },
              );
              if (accion !== 'feedback') setSugerencia(null);
              if (accion === 'send') await Promise.all([cargarConversacion(seleccion), cargarLista()]);
            } catch (err) {
              setAviso((err as Error).message);
            }
          }}
          onCrearOportunidad={async (titulo) => {
            if (!session || !tenant || !detalle) return;
            setAviso(null);
            try {
              await apiFetch(config, session, tenant, '/deals', {
                method: 'POST',
                body: JSON.stringify({ contactId: detalle.contactId, title: titulo }),
              });
              setSugerencia((s) => (s ? { ...s, suggestDeal: false } : s));
            } catch (err) {
              setAviso((err as Error).message);
            }
          }}
          onVolver={() => setPane('lista')}
          onVerFicha={() => setPane('ficha')}
          onResponder={(texto) => accion('/messages', { body: texto })}
          onAsignar={(aQuien, motivo) => accion('/assign', { toOwnerId: aQuien, reason: motivo })}
          onEstado={(estado, hasta) => accion('/state', { state: estado, snoozedUntil: hasta })}
        />
      </section>

      {/* Panel 3 · Ficha (--bg-raised) */}
      <section
        aria-label="Ficha del contacto"
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-l border-line bg-raised md:flex md:w-72',
          pane === 'ficha' ? 'flex' : 'hidden',
        )}
      >
        <Ficha
          detalle={detalle}
          notas={notas}
          analisis={analisis}
          onVolver={() => setPane('chat')}
          onAgregarNota={async (texto) => {
            if (!session || !tenant || !seleccion) return;
            try {
              await apiFetch(config, session, tenant, `/conversations/${seleccion}/notes`, {
                method: 'POST',
                body: JSON.stringify({ body: texto }),
              });
              await cargarConversacion(seleccion);
            } catch (err) {
              setAviso((err as Error).message);
            }
          }}
        />
      </section>
    </div>
  );
}
