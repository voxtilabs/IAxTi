'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Dialog, DialogContent, DialogTitle, DialogDescription, toast,
  Avatar,
  EstadoVacio,
  Badge,
  IconoReloj,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
  useSession,
  CanalChip,
  nombreCanal,
  nombreVisible,
} from '@iaxti/ui/react';
import { estaEscribiendo } from '../../lib/teclado';
import { useSelectedTenant } from '../tenant-switcher';
import {
  apiFetch,
  type BusquedaHit,
  type ConversacionDetalle,
  type ConversacionItem,
  type Mensaje,
  type AnalisisDto,
  type NotaDto,
  type PlantillaDto,
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

interface SinSugerenciaDto {
  codigo: string;
  texto: string;
  queHacer?: string;
  loArreglaElNegocio: boolean;
}

interface RespuestaDeSugerencia {
  sugerencia: SugerenciaDto | null;
  motivo: SinSugerenciaDto | null;
}

export function Bandeja() {
  const tenant = useSelectedTenant();
  const negocioDeEntrada = useRef<string | null>(null);
  if (tenant && !negocioDeEntrada.current) negocioDeEntrada.current = tenant;
  return tenant ? <BandejaDelNegocio key={tenant} tenant={tenant} abrirDesdeUrl={tenant === negocioDeEntrada.current} />
    : <p className="p-8 text-muted">Elige un negocio en el selector para ver su bandeja.</p>;
}

function BandejaDelNegocio({ tenant, abrirDesdeUrl }: { tenant: string; abrirDesdeUrl: boolean }) {
  const { supabase, session, config } = useSession();
  const ayudaTrigger = useRef<HTMLButtonElement>(null);
  const [ayuda, setAyuda] = useState(false);
  const atajoEnCurso = useRef(false);
  const [vista, setVista] = useState<Vista>('todas');
  const [items, setItems] = useState<ConversacionItem[] | null>(null);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<ConversacionDetalle | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[] | null>(null);
  const [pane, setPane] = useState<Pane>('lista');
  const [aviso, setAviso] = useState<string | null>(null);
  const [atajos, setAtajos] = useState<QuickReplyDto[]>([]);
  /** Plantillas del negocio; null hasta que alguien abra el selector (#460). */
  const [plantillas, setPlantillas] = useState<PlantillaDto[] | null>(null);
  const [notas, setNotas] = useState<NotaDto[]>([]);
  const [sugerencia, setSugerencia] = useState<SugerenciaDto | null>(null);
  // Por qué NO hay sugerencia (#436). Sin esto, las cinco causas —sin
  // llave, sin asistente, apagado, sin saldo, todavía trabajando— se ven
  // igual desde acá: el panel vacío.
  const [sinSugerencia, setSinSugerencia] = useState<SinSugerenciaDto | null>(null);
  // Qué saliente se está reintentando (#445): sin esto, dos clics seguidos
  // mandan dos recuperaciones del mismo pedido.
  const [reintentando, setReintentando] = useState<string | null>(null);
  const [analisis, setAnalisis] = useState<AnalisisDto | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [hits, setHits] = useState<BusquedaHit[] | null>(null);
  const seleccionRef = useRef<string | null>(null);
  seleccionRef.current = seleccion;

  useEffect(() => {
    if (!abrirDesdeUrl) return;
    const id = new URLSearchParams(window.location.search).get('conversationId');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) { setSeleccion(id); setPane('chat'); }
  }, [abrirDesdeUrl]);

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
          apiFetch<RespuestaDeSugerencia | null>(
            config,
            session,
            tenant,
            `/conversations/${id}/suggestion`,
          ).catch(() => null),
          apiFetch<AnalisisDto>(config, session, tenant, `/conversations/${id}/analisis`).catch(() => null),
        ]);
        if (seleccionRef.current !== id) return;
        setDetalle(d);
        setMensajes(m);
        setNotas(n);
        setSugerencia(sug?.sugerencia ?? null);
        setSinSugerencia(sug?.motivo ?? null);
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
    if (seleccion) { setDetalle(null); setMensajes(null); void cargarConversacion(seleccion); }
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
      toast.success(path === '/state' && (body as { state?: string }).state === 'resolved' ? 'Conversación resuelta' : 'Conversación actualizada');
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

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || estaEscribiendo(event.target) || document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      if (event.key === '?') { event.preventDefault(); setAyuda(true); return; }
      if ((event.key === 'j' || event.key === 'k') && items?.length) {
        event.preventDefault();
        const current = items.findIndex((c) => c.id === seleccion);
        const next = current < 0 ? (event.key === 'j' ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, current + (event.key === 'j' ? 1 : -1)));
        setSeleccion(items[next].id); setPane('chat');
      } else if (event.key === 'e' && seleccion && detalle?.id === seleccion && detalle.state !== 'resolved' && !atajoEnCurso.current) {
        event.preventDefault(); atajoEnCurso.current = true;
        void accion('/state', { state: 'resolved' }).finally(() => { atajoEnCurso.current = false; });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  if (!tenant) {
    return <p className="p-8 text-muted">Elige un negocio en el selector para ver su bandeja.</p>;
  }

  const miId = session?.user?.id ?? '';

  return (
    <div className="pulso-inbox relative flex h-full min-h-0 overflow-hidden">
      <Dialog open={ayuda} onOpenChange={setAyuda}><DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); ayudaTrigger.current?.focus(); }}>
        <DialogTitle>Atajos de la bandeja</DialogTitle>
        <DialogDescription>Funcionan cuando no estás escribiendo en un campo.</DialogDescription>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-dato">
          <dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Siguiente / anterior conversación</dd>
          <dt><kbd>e</kbd></dt><dd>Resolver la conversación abierta</dd>
          <dt><kbd>?</kbd></dt><dd>Mostrar esta ayuda</dd>
          <dt><kbd>Ctrl+K</kbd> / <kbd>⌘K</kbd></dt><dd>Buscar o ir a una pantalla</dd>
        </dl>
      </DialogContent></Dialog>
      {/* Panel 1 · Lista (--bg-raised) */}
      <section
        aria-label="Conversaciones"
        data-densidad="densa"
        className={cn(
          'pulso-inbox-list relative w-full shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-line bg-raised lg:flex lg:w-80',
          pane === 'lista' ? 'flex' : 'hidden',
        )}
      >
        <div className="sticky top-0 z-10 shrink-0 border-b border-line bg-raised p-4">
          <EncabezadoDePagina titulo="Bandeja" className="mb-0" accion={<Button ref={ayudaTrigger} variant="fantasma" size="chico" onClick={() => setAyuda(true)} aria-label="Ayuda de atajos (?)">?</Button>} />
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
              <EstadoVacio compacto className="m-3" titulo={`Nada con “${busqueda}”`}
                descripcion="Prueba con otras palabras del mensaje o de la nota."
                accion={{ etiqueta: 'Limpiar búsqueda', onClick: () => { setBusqueda(''); setHits(null); } }} />
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
          <AvisoResultado>
            {aviso}
          </AvisoResultado>
        )}
        {items === null ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" />
          </div>
        ) : items.length === 0 ? (
          <EstadoVacio compacto className="m-3"
            titulo={vista === 'todas' ? 'Todavía no te escribe nadie' : 'Esta cola está al día'}
            descripcion={vista === 'todas' ? 'Cuando conectes WhatsApp, los mensajes de tus clientes llegan aquí con su historia.' : 'Las conversaciones que necesiten tu atención aparecerán aquí. Puedes revisar las demás colas.'}
            accion={vista === 'todas' ? { etiqueta: 'Conectar WhatsApp', href: '/ajustes/canales' } : { etiqueta: 'Ver todas las conversaciones', onClick: () => setVista('todas') }} />
        ) : (
          <ul className="flex flex-col">
            {items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  aria-current={seleccion === c.id ? 'true' : undefined}
                  onClick={() => { setSeleccion(c.id); setPane('chat'); }}
                  className={cn(
                    'pulso-conversation flex w-full items-center min-h-control gap-fila-gap border-b border-line px-fila-x py-fila-y text-dato text-left transition-colors hover:bg-rest',
                    seleccion === c.id && 'bg-rest',
                  )}
                >
                  <Avatar size="chico" nombre={c.contactName} fallback={c.contactPhone ?? nombreCanal(c.channel)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-dato font-medium text-ink">
                      {nombreVisible({
                        name: c.contactName,
                        phone: c.contactPhone,
                        channel: c.channel,
                        identity: c.contactIdentity,
                      })}
                    </span>
                    <span className="flex items-center gap-1 font-mono text-rotulo text-muted">
                      {/* De dónde viene el mensaje: con tres canales, saberlo
                          antes de abrir cambia cómo se responde. */}
                      <CanalChip canal={c.channel} soloIcono />
                      {c.contactPhone ?? c.contactIdentity ?? nombreCanal(c.channel)}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <Badge role={ESTADOS[c.state].role}>{ESTADOS[c.state].label}</Badge>
                    {c.unansweredSeconds !== null && (
                      <span className="flex items-center gap-1 font-mono text-rotulo text-warn-text">
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
          'pulso-chat min-h-0 min-w-0 flex-1 flex-col bg-bg lg:flex',
          pane === 'chat' ? 'flex' : 'hidden',
        )}
      >
        <Chat
          detalle={detalle}
          mensajes={mensajes}
          atajos={atajos}
          plantillas={plantillas}
          onCargarPlantillas={async () => {
            if (!session || !tenant) return;
            try {
              setPlantillas(await apiFetch<PlantillaDto[]>(config, session, tenant, '/plantillas'));
            } catch (err) {
              // Sin plantillas no hay selector, pero sí hay que decir por qué:
              // el módulo whatsapp puede estar apagado en este plan.
              setPlantillas([]);
              setAviso((err as Error).message);
            }
          }}
          onAbrirAdjunto={(key) => {
            if (!session || !tenant) return;
            // La pestaña se abre DENTRO del clic y se llena después: si se
            // abriera al volver la URL firmada, el navegador la bloquearía
            // por no venir de un gesto de la persona.
            const ventana = window.open('', '_blank', 'noopener');
            void (async () => {
              try {
                const { url } = await apiFetch<{ url: string }>(
                  config,
                  session,
                  tenant,
                  `/attachments/url?key=${encodeURIComponent(key)}`,
                );
                if (ventana) ventana.location.href = url;
                else window.location.href = url;
              } catch (err) {
                ventana?.close();
                setAviso((err as Error).message);
              }
            })();
          }}
          onEnviarPlantilla={async (templateId, valores) => {
            if (!session || !tenant || !seleccion) return;
            setAviso(null);
            try {
              await apiFetch(config, session, tenant, `/plantillas/${templateId}/enviar`, {
                method: 'POST',
                body: JSON.stringify({ conversationId: seleccion, valores }),
              });
              await cargarConversacion(seleccion);
            } catch (err) {
              setAviso((err as Error).message);
              throw err;
            }
          }}
          sugerencia={sugerencia}
          sinSugerencia={sinSugerencia}
          reintentando={reintentando}
          onReintentar={async (messageId) => {
            if (!session || !tenant || !seleccion) return;
            setAviso(null);
            setReintentando(messageId);
            try {
              await apiFetch(
                config,
                session,
                tenant,
                `/conversations/${seleccion}/messages/${messageId}/retry-delivery`,
                { method: 'POST' },
              );
              // El estado lo cambia el despacho, no esta respuesta: se
              // recarga para mostrar lo que de verdad quedó.
              await cargarConversacion(seleccion);
            } catch (err) {
              setAviso((err as Error).message);
            } finally {
              setReintentando(null);
            }
          }}
          modo={analisis?.mode ?? null}
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
          onCobrar={async (montoClp, concepto) => {
            if (!session || !tenant || !seleccion) return;
            setAviso(null);
            try {
              await apiFetch(config, session, tenant, '/payments/links', {
                method: 'POST',
                body: JSON.stringify({ conversationId: seleccion, amountClp: montoClp, concept: concepto }),
              });
              await cargarConversacion(seleccion);
            } catch (err) {
              setAviso((err as Error).message);
            }
          }}
          onModo={async (modo) => {
            if (!session || !tenant || !seleccion) return;
            setAviso(null);
            try {
              await apiFetch(config, session, tenant, `/conversations/${seleccion}/agent-mode`, {
                method: 'POST',
                body: JSON.stringify({ mode: modo }),
              });
              setAnalisis((a) => (a ? { ...a, mode: modo } : a));
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
          onResponder={async (texto, archivo) => {
            // El archivo se sube a R2 con una URL prefirmada ANTES de
            // mandar el mensaje: si la subida falla, no queda un mensaje
            // prometiendo un adjunto que no existe (#458).
            let adjuntos;
            if (archivo && session && tenant && seleccion) {
              const permiso = await apiFetch<{ key: string; uploadUrl: string }>(
                config,
                session,
                tenant,
                `/conversations/${seleccion}/attachments`,
                { method: 'POST', body: JSON.stringify({ filename: archivo.name }) },
              );
              const subida = await fetch(permiso.uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': archivo.type || 'application/octet-stream' },
                body: archivo,
              });
              if (!subida.ok) throw new Error('No pudimos subir el archivo. Inténtalo de nuevo.');
              adjuntos = [
                {
                  key: permiso.key,
                  filename: archivo.name,
                  contentType: archivo.type || 'application/octet-stream',
                },
              ];
            }
            await accion('/messages', { body: texto, ...(adjuntos ? { adjuntos } : {}) });
          }}
          onAsignar={(aQuien, motivo) => accion('/assign', { toOwnerId: aQuien, reason: motivo })}
          onEstado={(estado, hasta) => accion('/state', { state: estado, snoozedUntil: hasta })}
        />
      </section>

      {/* Panel 3 · Ficha (--bg-raised) */}
      <section
        aria-label="Ficha del contacto"
        className={cn(
          'pulso-inbox-detail relative w-full shrink-0 flex-col overflow-y-auto overscroll-contain border-l border-line bg-raised lg:flex lg:w-72',
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
