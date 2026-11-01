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
import { usePieza, type Pieza } from '../arranque';
import type { SecuenciaDto, InscripcionDto } from './secuencias-ficha';
import { ListaDeAtajos } from './atajos-de-la-bandeja';
import { useSelectedTenant } from '../tenant-switcher';
import {
  apiFetch,
  type BusquedaHit,
  type ConversacionDetalle,
  type ConversacionItem,
  type Mensaje,
  type AnalisisDto,
  type EtiquetaDto,
  type FichaContacto as FichaDeContacto,
  type NotaDto,
  type PlantillaDto,
  type QuickReplyDto,
  type SugerenciaDto,
  avisoDe,
  type Aviso,
} from '../../lib/api';
import { Chat, type LimitesDeAdjunto } from './chat';
import { Ficha } from './ficha';
import { ESTADOS, fmtEspera, insigniaDePrioridad } from './estado';

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

/**
 * Cuántos mensajes trae cada página (#581).
 *
 * Es el mismo número que el servidor usa por omisión, y va explícito acá por un
 * motivo: la pantalla decide «puede haber anteriores» comparando cuántos vinieron
 * contra cuántos pidió. Si el número vive solo en el servidor, esa comparación se
 * hace contra una suposición y el botón de «ver lo anterior» aparece o desaparece
 * por su cuenta el día que alguien cambie el defecto.
 */
const PAGINA_MENSAJES = 50;
/**
 * Cada cuánto se trae la lista cuando NO hay canal de tiempo real (#1116).
 *
 * 20 s y no 5: el respaldo tiene que mantener la bandeja utilizable, no imitar
 * al realtime. Cinco segundos por cada pestaña abierta de cada persona del
 * equipo es carga constante contra la API por una caída que puede durar horas,
 * y veinte segundos de atraso en el peor caso no le cuestan un cliente a nadie
 * —lo que se los cuesta es una bandeja que no se mueve NUNCA.
 */
const RESPALDO_MS = 20_000;
/**
 * Cuánto se espera antes de DECIR que no hay tiempo real (#1116).
 *
 * `enVivo` arranca en false porque al cargar todavía no conectó, y conectar
 * toma un instante. Sin esta gracia el aviso parpadearía en cada carga de la
 * bandeja, y un aviso que aparece y se va solo enseña a ignorarlo — que es
 * justo lo contrario de lo que este aviso tiene que conseguir.
 */
const GRACIA_MS = 6_000;

/**
 * Lo que contesta `GET /conversations/:id/arranque` (#761).
 *
 * Cada pieza trae su estado porque «no tienes permiso» no es «no hay»: un `null`
 * para los dos haría que el panel diga «sin notas» a quien no puede verlas.
 */
interface ArranqueUrgente {
  conversacion: ConversacionDetalle;
  limitesDeAdjunto: LimitesDeAdjunto;
  mensajes: Pieza<Mensaje[]>;
}

/**
 * Tres piezas, no siete: la ficha del contacto y las secuencias las piden sus
 * propios componentes cuando se abren, que es otro momento y con otros
 * parámetros. Traerlas acá era pagar cuatro consultas por apertura para tirar
 * el resultado.
 */
interface ArranqueDeFicha {
  notas: Pieza<NotaDto[]>;
  sugerencia: Pieza<RespuestaDeSugerencia>;
  analisis: Pieza<AnalisisDto>;
  contacto: Pieza<FichaDeContacto | null>;
  etiquetasDelContacto: Pieza<EtiquetaDto[]>;
  /**
   * Las inscripciones son del CONTACTO; el catálogo de secuencias no — ese sale
   * del arranque del shell, porque es del negocio y es el mismo para toda
   * conversación. Un dato vive donde dice su alcance.
   */
  inscripciones: Pieza<InscripcionDto[]>;
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
  const [limites, setLimites] = useState<LimitesDeAdjunto | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[] | null>(null);
  // Cuántos trae cada página y si puede haber más. Si la página vino COMPLETA
  // puede haber anteriores; si vino corta, se llegó al principio del hilo. No se
  // cuenta cuántos quedan: sería una consulta sobre meses de mensajes para
  // responder algo que no se muestra en ningún lado (#581).
  const [hayAnteriores, setHayAnteriores] = useState(false);
  const [trayendoAnteriores, setTrayendoAnteriores] = useState(false);
  const [pane, setPane] = useState<Pane>('lista');
  const [aviso, setAviso] = useState<Aviso | null>(null);
  /** Si el canal de tiempo real está conectado. Arranca en false: todavía no (#1116). */
  const [enVivo, setEnVivo] = useState(false);
  /** Si además ya pasó la gracia, o sea: vale la pena decirlo. */
  const [decirSinVivo, setDecirSinVivo] = useState(false);
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
  /**
   * Lo de la FICHA, que viene en el mismo arranque y baja por props (#761).
   *
   * `null` significa «todavía no» o «no se puede ver», y los componentes de
   * abajo tratan las dos igual que antes: piden lo suyo si no les llega nada.
   * Así la pantalla de contactos —que usa el mismo `FichaContacto` y no tiene
   * conversación— sigue funcionando sin cambios.
   */
  const [fichaDelContacto, setFichaDelContacto] = useState<FichaDeContacto | null>(null);
  const [etiquetasDelContacto, setEtiquetasDelContacto] = useState<EtiquetaDto[]>([]);
  const [inscripciones, setInscripciones] = useState<InscripcionDto[] | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [hits, setHits] = useState<BusquedaHit[] | null>(null);
  const seleccionRef = useRef<string | null>(null);
  seleccionRef.current = seleccion;

  useEffect(() => {
    if (!abrirDesdeUrl) return;
    const id = new URLSearchParams(window.location.search).get('conversationId');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) { setSeleccion(id); setPane('chat'); }
  }, [abrirDesdeUrl]);

  /**
   * En escritorio, la bandeja abre con la primera conversación puesta (#1165).
   *
   * Medido antes de esto a 1.440 px: la lista usaba 440 y los otros 1.000
   * quedaban en blanco, con la chuleta de atajos de teclado al medio. Lo
   * primero que ve alguien al abrir la pantalla donde más se trabaja no puede
   * ser `j / k`.
   *
   * Ningún buzón hace eso: Gmail, Front, Intercom y Superhuman abren la
   * primera. La pantalla de tres paneles existe para ver lista, conversación
   * y ficha a la vez; con el centro vacío son dos paneles y un hueco.
   *
   * En CELULAR no: ahí los paneles se apilan y la lista es la pantalla, así
   * que abrir sola dejaría a alguien adentro de una conversación que no pidió
   * y con el botón de volver como única salida.
   *
   * Una sola vez por montaje, y por eso el `ref` y no mirar solo `seleccion`:
   * sin él, cerrar una conversación volvería a abrir la primera y no habría
   * forma de quedarse en la lista.
   */
  const yaAbrioSola = useRef(false);
  useEffect(() => {
    if (yaAbrioSola.current) return;
    // Si la URL ya eligió una, esa manda y no se vuelve a intentar.
    if (seleccion) { yaAbrioSola.current = true; return; }
    if (!items || items.length === 0) return;
    if (!window.matchMedia('(min-width: 1024px)').matches) return;
    yaAbrioSola.current = true;
    setSeleccion(items[0].id);
    setPane('chat');
  }, [items, seleccion]);

  const cargarLista = useCallback(async () => {
    if (!session || !tenant) return;
    const query = vista === 'todas' ? '' : `?view=${vista}`;
    try {
      const res = await apiFetch<{ items: ConversacionItem[] }>(
        config, session, tenant, `/conversations${query}`,
      );
      setItems(res.items);
    } catch (err) {
      setAviso(avisoDe(err));
    }
  }, [config, session, tenant, vista]);

  /**
   * Traer los mensajes ANTERIORES a los que ya están (#581).
   *
   * El cursor es el `seq` del más viejo que tenemos, y no su fecha: `seq` es
   * estrictamente creciente por conversación, así que no se puede saltar ni
   * repetir un mensaje aunque dos lleguen en el mismo milisegundo — y en
   * WhatsApp llegan ráfagas.
   *
   * Los anteriores se pegan al FINAL del arreglo porque la lista viaja del más
   * nuevo al más viejo; la pantalla la da vuelta para dibujar.
   */
  const traerAnteriores = useCallback(async () => {
    if (!session || !tenant || !seleccion || trayendoAnteriores) return;
    const actuales = mensajes;
    if (!actuales || actuales.length === 0) return;
    const masViejo = actuales[actuales.length - 1];
    if (!masViejo?.seq) return;
    setTrayendoAnteriores(true);
    try {
      const anteriores = await apiFetch<Mensaje[]>(
        config,
        session,
        tenant,
        `/conversations/${seleccion}/messages?limit=${PAGINA_MENSAJES}&antesDe=${masViejo.seq}`,
      );
      setMensajes((previos) => [...(previos ?? []), ...anteriores]);
      setHayAnteriores(anteriores.length >= PAGINA_MENSAJES);
    } catch (err) {
      setAviso(avisoDe(err));
    } finally {
      setTrayendoAnteriores(false);
    }
  }, [config, session, tenant, seleccion, mensajes, trayendoAnteriores]);

  const cargarConversacion = useCallback(
    async (id: string) => {
      if (!session || !tenant) return;
      const sigueAbierta = () => seleccionRef.current === id;
      try {
        /**
         * Dos llamadas en vez de seis (#761), SIN deshacer lo de #690.
         *
         * La primera versión de esto era una sola llamada que traía todo, y las
         * pruebas de #690 la frenaron — con razón. Esas seis peticiones estaban
         * separadas a propósito: la pantalla se dibuja CUANDO LLEGA el hilo en
         * vez de esperar a la última, porque el 28/09 el proveedor de IA se puso
         * a encolar y la misma petición pasó de 2 s a 170 s con la bandeja en
         * blanco. Y una respuesta agrupada es PEOR que un `Promise.all`: dentro
         * de una respuesta HTTP no hay forma de dibujar lo que ya llegó.
         *
         * Así que el arranque son dos: el urgente —hilo, mensajes y qué se puede
         * adjuntar, todo lectura de base— que es el único que se espera, y la
         * ficha, que entra sola y puede no llegar.
         *
         * Lo que se gana: 6 puertas → 2, y cada una pagaba su propio
         * BEGIN/set_config/COMMIT (#711: 64 ms por viaje).
         */
        const pedir = <T,>(ruta: string) => apiFetch<T>(config, session, tenant, ruta);

        // Lo urgente: el hilo y poder responder.
        const loUrgente = pedir<ArranqueUrgente>(`/conversations/${id}/arranque`).then((a) => {
          if (!sigueAbierta()) return;
          setDetalle(a.conversacion);
          const mensajes = a.mensajes.estado === 'ok' ? a.mensajes.dato : [];
          setMensajes(mensajes);
          setHayAnteriores(mensajes.length >= PAGINA_MENSAJES);
          setLimites(a.limitesDeAdjunto);
        });

        // Y la ficha entra sola. Las piezas que no se pueden ver quedan en null,
        // que es lo que ya significaba «no está» para el panel.
        void pedir<ArranqueDeFicha>(`/conversations/${id}/arranque/ficha`)
          .then((f) => {
            if (!sigueAbierta()) return;
            setNotas(f.notas.estado === 'ok' ? f.notas.dato : []);
            setSugerencia(f.sugerencia.estado === 'ok' ? f.sugerencia.dato.sugerencia : null);
            setSinSugerencia(f.sugerencia.estado === 'ok' ? f.sugerencia.dato.motivo : null);
            setAnalisis(f.analisis.estado === 'ok' ? f.analisis.dato : null);
            // Lo de la ficha baja por props: antes cada componente lo pedía por
            // su cuenta y eran cuatro puertas más por conversación abierta,
            // medidas en el e2e de #711.
            setFichaDelContacto(f.contacto.estado === 'ok' ? f.contacto.dato : null);
            setEtiquetasDelContacto(
              f.etiquetasDelContacto.estado === 'ok' ? f.etiquetasDelContacto.dato : [],
            );
            setInscripciones(f.inscripciones.estado === 'ok' ? f.inscripciones.dato : null);
          })
          .catch(() => {});

        // Solo se espera lo urgente: si ESO falla, la pantalla lo dice.
        await loUrgente;
      } catch (err) {
        setAviso(avisoDe(err));
      }
    },
    [config, session, tenant],
  );

  useEffect(() => void cargarLista(), [cargarLista]);
  // Los atajos vienen del arranque del shell (#761): son del negocio y míos,
  // no de la conversación, así que se piden una vez por sesión y no por tenant
  // en cada montaje de la bandeja.
  // El catálogo de secuencias del negocio, del arranque del shell: igual para
  // toda conversación, así que no se descarta al cambiar de contacto.
  const secuenciasDelNegocio = usePieza('secuencias');
  const secuencias = (secuenciasDelNegocio.dato as SecuenciaDto[] | undefined) ?? null;
  const atajosDelArranque = usePieza('respuestasRapidas');
  useEffect(() => {
    if (atajosDelArranque.puedeVerla && atajosDelArranque.dato) {
      setAtajos(atajosDelArranque.dato as QuickReplyDto[]);
    }
  }, [atajosDelArranque.puedeVerla, atajosDelArranque.dato]);
  useEffect(() => {
    if (seleccion) {
      /**
       * TODO lo de la conversación anterior se descarta, no solo el hilo.
       *
       * Faltaban seis: `notas`, `sugerencia`, `sinSugerencia`, `analisis`, la
       * ficha del contacto y sus etiquetas. Y el hueco lo abrió #761 al partir
       * el arranque en dos llamadas: cuando vuelve la URGENTE —hilo y
       * mensajes— `detalle` ya es el contacto NUEVO, pero lo de la ficha sigue
       * siendo del anterior hasta que llega la segunda respuesta.
       *
       * O sea que durante esa ventana la pantalla muestra **las notas internas
       * de un cliente bajo el nombre de otro**. En una bandeja compartida eso
       * no es un parpadeo: es leer sobre Ana lo que el equipo escribió sobre
       * Pedro, y actuar en consecuencia.
       *
       * Antes de #761 no pasaba porque cada pieza tenía su propia llamada y su
       * propio `setX(null)` al empezar. Agrupar movió el momento en que llega
       * cada dato, y los reinicios se quedaron donde estaban.
       */
      setDetalle(null);
      setMensajes(null);
      setLimites(null);
      setHayAnteriores(false);
      setNotas([]);
      setSugerencia(null);
      setSinSugerencia(null);
      setAnalisis(null);
      setFichaDelContacto(null);
      setEtiquetasDelContacto([]);
      setInscripciones(null);
      void cargarConversacion(seleccion);
    }
  }, [seleccion, cargarConversacion]);

  // Realtime por broadcast (SPEC §40): canal privado del tenant; cualquier
  // evento refresca la lista, y la conversación abierta si es la suya.
  //
  // `subscribe()` iba sin callback, así que nadie miraba nunca si el canal
  // quedó conectado (#1116). Cuando no queda —token vencido, política del
  // canal, la red del local, el wifi del celular— la lista se queda con lo que
  // había y se ve EXACTAMENTE IGUAL que una bandeja sin mensajes nuevos.
  //
  // Quien atiende no puede distinguir «no escribió nadie» de «dejamos de
  // escuchar», y va a creer lo primero, que es lo tranquilizador. Después hay
  // un cliente esperando.
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
    canal.subscribe((estado) => setEnVivo(estado === 'SUBSCRIBED'));
    return () => {
      setEnVivo(false);
      void supabase.removeChannel(canal);
    };
  }, [supabase, session, tenant, cargarLista, cargarConversacion]);

  /**
   * El respaldo mientras el canal no está (#1116).
   *
   * Un cartel que dice «no estás en vivo» y nada más deja a la persona
   * apretando F5. Lo que mantiene el trabajo andando es seguir trayendo la
   * lista, más lento, hasta que el canal vuelva.
   *
   * Solo mientras NO hay canal: en cuanto conecta, el intervalo se limpia. Un
   * respaldo que sigue corriendo con el canal sano se vuelve el camino normal
   * —y entonces nadie se entera el día que el realtime deje de andar del todo.
   */
  useEffect(() => {
    if (enVivo || !session || !tenant) return;
    const t = setInterval(() => void cargarLista(), RESPALDO_MS);
    return () => clearInterval(t);
  }, [enVivo, session, tenant, cargarLista]);

  // Decirlo recién pasada la gracia, y dejar de decirlo apenas vuelve.
  useEffect(() => {
    if (enVivo) {
      setDecirSinVivo(false);
      return;
    }
    const t = setTimeout(() => setDecirSinVivo(true), GRACIA_MS);
    return () => clearTimeout(t);
  }, [enVivo]);

  /**
   * Devuelve si la acción SALIÓ. Antes era `void` y se tragaba el fallo: quien
   * la llamaba no podía distinguir un envío bueno de uno rechazado, así que la
   * bandeja mostraba el aviso y al mismo tiempo borraba el borrador (#560).
   */
  /**
   * El mensaje que se dibuja ANTES de que el servidor conteste (#671).
   *
   * Responder tomaba el POST más seis llamadas de recarga, y hasta que volvía la
   * última el chat se veía igual que antes de apretar Enviar. Con el proveedor
   * lento eso son segundos mirando una pantalla que no acusa recibo, y la reacción
   * natural es apretar otra vez.
   *
   * Nace en `queued`, que es el estado real —aún no salió— y el mismo que usa la
   * entrega: cuando vuelve el servidor, el mensaje de verdad lo reemplaza con su
   * id y su estado. Si falla, se saca.
   */
  function mensajeOptimista(body: unknown, previos: Mensaje[] | null): Mensaje | null {
    const texto = (body as { body?: unknown })?.body;
    if (typeof texto !== 'string' || texto.trim() === '') return null;
    const tope = (previos ?? []).reduce((max, m) => Math.max(max, m.seq ?? 0), 0);
    return {
      id: `optimista-${Date.now()}`,
      direction: 'out',
      type: 'text',
      body: texto,
      deliveryStatus: 'queued',
      authorKind: 'user',
      seq: tope + 1,
      createdAt: new Date().toISOString(),
    };
  }

  async function accion(path: string, body: unknown): Promise<boolean> {
    if (!session || !tenant || !seleccion) return false;
    setAviso(null);
    // Solo los mensajes: resolver o asignar no tiene nada que dibujar antes de
    // tiempo, y adelantarse ahí sería mentir sobre un estado que no cambió.
    const optimista = path === '/messages' ? mensajeOptimista(body, mensajes) : null;
    if (optimista) setMensajes((previos) => [optimista, ...(previos ?? [])]);
    try {
      await apiFetch(config, session, tenant, `/conversations/${seleccion}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Un cambio de ESTADO refresca solo el detalle y la lista (#654).
      //
      // `cargarConversacion` pide SEIS cosas en paralelo: detalle, mensajes,
      // notas, sugerencia del copiloto, análisis y límites de adjunto. Resolver,
      // asignar o posponer no cambia ninguna de las cinco últimas, y sin embargo
      // el encabezado no mostraba el estado nuevo hasta que volvía la más lenta
      // —que puede ser la sugerencia, que la calcula un modelo—. Una acción ya
      // confirmada por el servidor se veía colgada esperando a la IA.
      //
      // Para todo lo demás se recarga el paquete entero, y eso NO es por las
      // dudas: al responder, el mensaje nuevo aparece porque se recargan los
      // mensajes. La primera versión de este arreglo lo aplicó a todas las
      // acciones y el mensaje enviado dejó de aparecer en el chat — lo cazó la
      // prueba de la bandeja, fallando en otro punto.
      if (path === '/state') {
        const [d] = await Promise.all([
          apiFetch<ConversacionDetalle>(config, session, tenant, `/conversations/${seleccion}`),
          cargarLista(),
        ]);
        if (seleccionRef.current === seleccion) setDetalle(d);
      } else {
        await Promise.all([cargarConversacion(seleccion), cargarLista()]);
      }
      toast.success(path === '/state' && (body as { state?: string }).state === 'resolved' ? 'Conversación resuelta' : 'Conversación actualizada');
      return true;
    } catch (err) {
      // Se saca el que se adelantó: dejarlo ahí diría que el mensaje salió.
      if (optimista) setMensajes((previos) => (previos ?? []).filter((m) => m.id !== optimista.id));
      setAviso(avisoDe(err));
      return false;
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
      setAviso(avisoDe(err));
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
        <div className="mt-4"><ListaDeAtajos /></div>
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
            {/* Sin `flex-1` (#1111): repartir tercios iguales daba 96 px por
                pestaña y «Sin responder» se partía en dos líneas, que es de
                las cosas que se leen como producto a medio hacer. Los tres
                rótulos juntos sí entran en los 288 px de la columna; lo que no
                entraba era el tercio. */}
            <TabsList className="w-full justify-between">
              <TabsTrigger value="todas">Todas</TabsTrigger>
              <TabsTrigger value="mi_cola">Mi cola</TabsTrigger>
              <TabsTrigger value="sin_responder">Sin responder</TabsTrigger>
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
          {/* Degradado, no roto, y la diferencia es justo la que el producto
              tiene que saber decir (#1116). Nada de rojo: la bandeja SIGUE
              trayendo mensajes, solo que más lento. Lo que no puede pasar es
              que se vea igual que una bandeja sin novedades. */}
          {decirSinVivo && (
            <p role="status" className="mt-3 rounded-campo bg-warn-soft px-3 py-2 text-dato text-warn-text">
              Sin conexión en vivo. Seguimos revisando cada 20 segundos.
            </p>
          )}
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
            {aviso.texto}
            {aviso.rastro && <span className="dato mt-1 block text-rotulo text-muted">{aviso.rastro}</span>}
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
                    'pulso-conversation flex w-full items-center gap-fila-gap border-b border-line px-fila-x py-fila-y text-dato text-left transition-colors hover:bg-rest',
                    seleccion === c.id && 'bg-rest',
                  )}
                >
                  {/* Dos líneas con el avatar al LADO, no encima: arriba quién
                      y en qué está; abajo, lo último que dijo.

                      Compartiendo una sola línea con el chip de canal y las
                      insignias, al preview le quedaban unos dieciocho
                      caracteres —«Hola, ¿me pueden ayu…»— y eso no alcanza
                      para saber de qué va sin abrir.

                      Con el avatar arriba, en cambio, la fila se iba a 79 px y
                      `densidad.spec.ts` lo rechaza: el presupuesto es 60 px y
                      ocho conversaciones a la vista. Una bandeja que muestra
                      cinco en vez de diez es peor aunque cada fila se lea
                      mejor. Al lado, el avatar cabe dentro del alto de las dos
                      líneas y no suma nada. */}
                  <Avatar size="chico" nombre={c.contactName} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate leading-tight text-dato font-medium text-ink">
                      {nombreVisible({
                        name: c.contactName,
                        phone: c.contactPhone,
                        channel: c.channel,
                        identity: c.contactIdentity,
                      })}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                    <Badge role={ESTADOS[c.state].role}>{ESTADOS[c.state].label}</Badge>
                    {/* La prioridad en la lista (#550): es ahí donde sirve,
                        porque es la lista la que ahora viene ordenada por
                        ella. Solo si no es normal. */}
                    {insigniaDePrioridad(c.priority) && (
                      <Badge role={insigniaDePrioridad(c.priority)!.role}>
                        {insigniaDePrioridad(c.priority)!.label}
                      </Badge>
                    )}
                      {c.unansweredSeconds !== null && (
                        <span className="flex items-center gap-1 font-mono text-rotulo text-warn-text">
                          <IconoReloj className="h-3 w-3" />
                          {fmtEspera(c.unansweredSeconds)}
                        </span>
                      )}
                    </span>
                    </span>
                  {/* De dónde viene y qué dijo. El canal importa antes de
                      abrir —con tres, cambia cómo se responde— y la frase se
                      lleva el resto del ancho. Sin texto —una imagen, un
                      audio— cae al identificador, que es lo que había. */}
                    <span className="flex w-full items-center gap-1.5 leading-tight text-rotulo text-muted">
                      <CanalChip canal={c.channel} soloIcono />
                      <span className="min-w-0 flex-1 truncate">
                        {c.lastMessagePreview
                          ?? c.contactPhone ?? c.contactIdentity ?? nombreCanal(c.channel)}
                      </span>
                    </span>
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
          abriendo={!!seleccion}
          mensajes={mensajes}
          hayAnteriores={hayAnteriores}
          trayendoAnteriores={trayendoAnteriores}
          onVerAnteriores={traerAnteriores}
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
              setAviso(avisoDe(err));
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
                setAviso(avisoDe(err));
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
              setAviso(avisoDe(err));
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
              setAviso(avisoDe(err));
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
              // Aplicar la acción cambia el negocio —una cita, un cobro, un
              // estado— así que se recarga igual que al enviar la sugerencia.
              if (accion === 'send' || accion === 'accion') {
                await Promise.all([cargarConversacion(seleccion), cargarLista()]);
              }
            } catch (err) {
              setAviso(avisoDe(err));
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
              setAviso(avisoDe(err));
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
              setAviso(avisoDe(err));
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
              setAviso(avisoDe(err));
            }
          }}
          limitesDeAdjunto={limites}
          onVolver={() => setPane('lista')}
          onVerFicha={() => setPane('ficha')}
          onResponder={async (texto, archivo) => {
            // El archivo se sube a R2 con una URL prefirmada ANTES de
            // mandar el mensaje: si la subida falla, no queda un mensaje
            // prometiendo un adjunto que no existe (#458).
            let adjuntos;
            if (archivo && session && tenant && seleccion) {
              const contentType = archivo.type || 'application/octet-stream';
              try {
                // La ruta revisa tipo y tamaño ANTES de firmar (#560): si el
                // archivo no cabe, no se sube nada y el mensaje que vuelve ya
                // dice cuál es el máximo de ESA clase.
                const permiso = await apiFetch<{ key: string; uploadUrl: string }>(
                  config,
                  session,
                  tenant,
                  `/conversations/${seleccion}/attachments`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      filename: archivo.name,
                      contentType,
                      sizeBytes: archivo.size,
                    }),
                  },
                );
                const subida = await fetch(permiso.uploadUrl, {
                  method: 'PUT',
                  headers: { 'Content-Type': contentType },
                  body: archivo,
                });
                if (!subida.ok) throw new Error('No pudimos subir el archivo. Inténtalo de nuevo.');
                adjuntos = [{ key: permiso.key, filename: archivo.name, contentType }];
              } catch (err) {
                // Sin este catch el error se escapaba de `onResponder` y de
                // `enviar`, que tampoco lo tenía: quedaba una promesa
                // rechazada sin dueño, el clip puesto y NINGÚN aviso en
                // pantalla. Con el rechazo por tamaño de #560 eso habría hecho
                // invisible justamente lo que se agregó.
                setAviso(avisoDe(err));
                return false;
              }
            }
            return accion('/messages', { body: texto, ...(adjuntos ? { adjuntos } : {}) });
          }}
          onAsignar={(aQuien, motivo) => accion('/assign', { toOwnerId: aQuien, reason: motivo })}
          onEstado={(estado, hasta) => accion('/state', { state: estado, snoozedUntil: hasta })}
          onPrioridad={(prioridad) => accion('/prioridad', { prioridad })}
        />
      </section>

      {/* Panel 3 · Ficha (--bg-raised)
          Solo con conversación elegida (#1111). Sin selección, esta ficha y el
          chat eran DOS áreas vacías de 288 y 416 px —el 69% del ancho útil a
          1280— diciendo cada una que estaba vacía. Dos vacíos lado a lado es lo
          que se lee como inacabado; uno, no.
          En celular no cambia nada: `pane` nunca llega a 'ficha' sin pasar por
          el chat de una conversación. */}
      {seleccion && (
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
          fichaDelContacto={fichaDelContacto}
          etiquetasDelContacto={etiquetasDelContacto}
          secuencias={secuencias}
          inscripciones={inscripciones}
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
              setAviso(avisoDe(err));
            }
          }}
        />
      </section>
      )}
    </div>
  );
}
