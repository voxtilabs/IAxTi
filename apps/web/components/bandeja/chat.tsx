'use client';

import { AvisoResultado, toast } from '@iaxti/ui/react';

import { Bot, Paperclip, ThumbsDown, ThumbsUp } from 'lucide-react';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconoAlerta,
  IconoCheck,
  IconoChevronAbajo,
  IconoDobleCheck,
  IconoEnviar,
  IconoPersona,
  IconoReloj,
  IconoVolver,
  Input,
  Textarea,
  cn,
  useArrastre,
} from '@iaxti/ui/react';
import {
  ventanaAbierta,
  renderPlantilla,
  renderQuickReply,
  variablesDePlantilla,
  type ConversacionDetalle,
  type ConversacionItem,
  type Mensaje,
  type PlantillaDto,
  type QuickReplyDto,
  type SugerenciaDto,
  type Aviso,
} from '../../lib/api';
import { ESTADOS, PRIORIDADES, insigniaDePrioridad } from './estado';

/** Cuántos valores pide una plantilla: el mayor índice, como en el servidor. */
function cuantasVariables(p: PlantillaDto): number {
  const vars = variablesDePlantilla(p.body);
  return vars.length === 0 ? 0 : Math.max(...vars);
}

function HoraDato({ iso }: { iso: string }) {
  const d = new Date(iso);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return <time dateTime={iso} className="dato text-faint">{hh}:{mm}</time>;
}

function Entrega({ estado }: { estado: Mensaje['deliveryStatus'] }) {
  if (estado === 'read') return <IconoDobleCheck className="h-3.5 w-3.5 text-action-text" aria-label="Leído" />;
  if (estado === 'delivered') return <IconoDobleCheck className="h-3.5 w-3.5 text-faint" aria-label="Entregado" />;
  if (estado === 'sent') return <IconoCheck className="h-3.5 w-3.5 text-faint" aria-label="Enviado" />;
  if (estado === 'failed') return <IconoAlerta className="h-3.5 w-3.5 text-bad-text" aria-label="Falló" />;
  return <IconoReloj className="h-3.5 w-3.5 text-faint" aria-label="En cola" />;
}

/**
 * Lo que este canal acepta como adjunto (#560). Lo sirve la API desde la tabla
 * del módulo `channels`; acá no hay ningún número escrito a mano, a propósito.
 */
export interface LimitesDeAdjunto {
  canal: string;
  limites: Array<{
    clase: string;
    nombre: string;
    maxBytes: number;
    tipos: string[];
  }>;
}

export interface ChatProps {
  detalle: ConversacionDetalle | null;
  mensajes: Mensaje[] | null;
  atajos: QuickReplyDto[];
  sugerencia: SugerenciaDto | null;
  /** Por qué NO hay sugerencia (#436). null = hay, o el módulo está apagado. */
  sinSugerencia: { codigo: string; texto: string; queHacer?: string; loArreglaElNegocio: boolean } | null;
  /** Modo efectivo del copiloto; null = módulo agents apagado. */
  modo: 'assist' | 'autonomous' | 'off' | null;
  miId: string;
  aviso: Aviso | null;
  /** Qué acepta este canal; null mientras carga o si la ruta falló. */
  limitesDeAdjunto: LimitesDeAdjunto | null;
  /** Si puede haber mensajes anteriores a los que ya están (#581). */
  hayAnteriores?: boolean;
  trayendoAnteriores?: boolean;
  /** Trae la página anterior. Ausente = la bandeja no lo soporta todavía. */
  onVerAnteriores?: () => void | Promise<void>;
  onVolver: () => void;
  onVerFicha: () => void;
  /**
   * Responde. El adjunto es opcional: una foto sola ya es un mensaje (#458).
   *
   * Devuelve si SALIÓ. Antes devolvía `void`, así que un envío fallido —fuera
   * de la ventana, sin permiso, el adjunto rechazado— se veía igual que uno
   * bueno desde acá y el borrador se borraba de todas formas (#560).
   */
  onResponder: (texto: string, adjunto?: File) => Promise<boolean>;
  // Como `onResponder`, devuelven si salió: la bandeja ya sabe distinguirlo y
  // esconderlo acá era lo que hacía que un fallo se viera como un éxito (#560).
  onAsignar: (aQuien: string, motivo?: string) => Promise<boolean>;
  onEstado: (estado: string, hasta?: string) => Promise<boolean>;
  /**
   * Subir o bajar la prioridad (#550).
   *
   * Va en el menú de Acciones y no como botón suelto: no es algo que se toque
   * en cada conversación, y un control permanente para eso le quitaría espacio
   * a lo que sí.
   */
  onPrioridad: (prioridad: ConversacionItem['priority']) => Promise<boolean>;
  onSugerencia: (accion: 'send' | 'dismiss' | 'feedback', extra?: Record<string, unknown>) => Promise<void>;
  /** Retoma el despacho de un saliente que falló (#445). */
  onReintentar: (messageId: string) => Promise<void>;
  /** Qué mensaje se está reintentando ahora, para no ofrecerlo dos veces. */
  reintentando: string | null;
  onModo: (modo: 'assist' | 'autonomous') => Promise<void>;
  onCobrar: (montoClp: number, concepto: string) => Promise<void>;
  onCrearOportunidad: (titulo: string) => Promise<void>;
  /**
   * Las plantillas aprobadas del negocio (#460). `null` = todavía no se
   * piden: se cargan al abrir el selector, porque fuera de la ventana de
   * 24 h es cuando importan y el módulo puede estar apagado.
   */
  plantillas: PlantillaDto[] | null;
  onCargarPlantillas: () => Promise<void>;
  onEnviarPlantilla: (templateId: string, valores: string[]) => Promise<void>;
  /** Abre un adjunto recibido; la URL se firma al pedirla y dura 15 min (#460). */
  onAbrirAdjunto: (key: string) => void;
}

/**
 * En qué se apoyó la sugerencia (#717).
 *
 * Una respaldada por el conocimiento del negocio y una dicha de memoria se
 * veían idénticas, y quien aprieta «Enviar sugerencia» es quien se hace
 * responsable de lo que sale. Darle el texto sin decirle en qué se apoya es
 * pedirle que firme a ciegas.
 *
 * No es una alarma: responder de memoria a veces está bien —un saludo no
 * necesita el CRM— y pintarlo de rojo enseñaría a ignorarlo. Es un dato, en
 * rótulo, antes de apretar.
 *
 * `undefined` no se muestra: es una sugerencia anterior a #699, cuando la
 * corrida no registraba qué usaba. Decir «sin consultar» ahí sería afirmar algo
 * que no sabemos — exactamente el defecto que venimos sacando toda la semana.
 */
function EnQueSeApoyo({ herramientas }: { herramientas?: string[] }) {
  if (herramientas === undefined) return null;
  return (
    <p className="mt-2 rotulo">
      {herramientas.length === 0
        ? 'Respondió sin consultar nada'
        : `Consultó ${herramientas.map(enCastellano).join(' y ')}`}
    </p>
  );
}

/** El nombre de la herramienta, como lo diría una persona. */
function enCastellano(herramienta: string): string {
  const nombres: Record<string, string> = {
    'knowledge.search': 'el conocimiento del negocio',
    'knowledge.get_product': 'el catálogo',
    'conversations.get_context': 'la conversación',
    'crm.get_contact': 'la ficha del contacto',
    'calendar.get_slots': 'la agenda',
  };
  return nombres[herramienta] ?? herramienta;
}

export function Chat({
  detalle, mensajes, atajos, sugerencia, sinSugerencia, modo, miId, aviso,
  hayAnteriores, trayendoAnteriores, onVerAnteriores,
  onReintentar, reintentando,
  onVolver, onVerFicha, onResponder, onAsignar, onEstado, onPrioridad, onSugerencia, onModo, onCobrar, onCrearOportunidad,
  plantillas, onCargarPlantillas, onEnviarPlantilla, onAbrirAdjunto, limitesDeAdjunto,
}: ChatProps) {
  const [motivoAbajo, setMotivoAbajo] = useState(false);
  const [motivoFeedback, setMotivoFeedback] = useState('');
  const [texto, setTexto] = useState('');
  /** El archivo elegido, todavía sin subir: se sube al enviar (#458). */
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [dialogoAsignar, setDialogoAsignar] = useState(false);
  const [dialogoCobrar, setDialogoCobrar] = useState(false);
  const [montoCobro, setMontoCobro] = useState('');
  const [conceptoCobro, setConceptoCobro] = useState('');
  const [aQuien, setAQuien] = useState('');
  const [dialogoPlantilla, setDialogoPlantilla] = useState(false);
  const [elegida, setElegida] = useState<PlantillaDto | null>(null);
  const [valores, setValores] = useState<string[]>([]);
  const [mandandoPlantilla, setMandandoPlantilla] = useState(false);
  const [motivo, setMotivo] = useState('');
  const historialRef = useRef<HTMLDivElement>(null);
  const estabaAbajo = useRef(true);
  /** Alto del historial antes de pegar los anteriores, para no perder el lugar. */
  const altoAntes = useRef<number | null>(null);
  /** Qué conversación está dibujada, para saber cuándo se está ABRIENDO otra. */
  const conversacionPintada = useRef<string | null>(null);

  /**
   * Bajar al último mensaje SOLO si ya estabas abajo (#581).
   *
   * Antes esto era `scrollTop = scrollHeight` en cada cambio de `mensajes`. Con
   * realtime encendido eso significa que si subís a leer algo que se le prometió
   * al cliente y entra un mensaje nuevo, te tira abajo de un tirón — justo
   * mientras estás leyendo, y justo en la conversación que más te importa.
   *
   * Y si lo que cambió son los mensajes ANTERIORES, bajar sería peor todavía:
   * pediste ver lo de antes y te manda al final. En ese caso se conserva el
   * lugar sumando lo que creció el contenido, que es lo que hace cualquier chat.
   */
  useEffect(() => {
    const historial = historialRef.current;
    if (!historial) return;
    if (altoAntes.current !== null) {
      // Llegaron los anteriores: el contenido creció hacia ARRIBA, así que se
      // empuja el scroll lo mismo que creció y la vista no se mueve un píxel.
      historial.scrollTop += historial.scrollHeight - altoAntes.current;
      altoAntes.current = null;
      return;
    }
    // Al ABRIR una conversación se baja siempre, sin preguntar. Lo primero que
    // alguien quiere ver es lo último que dijo el cliente, y el estado de «venía
    // mirando arriba» es de la conversación anterior, no de esta.
    //
    // Y no es solo lo correcto: es lo que hace falta. `estabaAbajo` se anota
    // desde el evento de scroll, que puede llegar ANTES de que corra este efecto
    // —React pinta y recién después ejecuta los efectos pasivos—, y con el
    // historial recién pintado arriba del todo esa anotación dice «no estabas
    // abajo». Sin esta rama, abrir una conversación te dejaba arriba de todo.
    const abriendo = conversacionPintada.current !== detalle?.id;
    if (abriendo || estabaAbajo.current) {
      historial.scrollTop = historial.scrollHeight;
      estabaAbajo.current = true;
    }
    // Solo se da por dibujada cuando TENÍA alto. En celular los tres paneles
    // están apilados y el del chat llega oculto: mientras lo está, su
    // `scrollHeight` es 0 y bajar no hace nada. Si se marcara igual, el efecto
    // no volvería a intentarlo y la conversación quedaría abierta arriba de
    // todo — que es lo que pasaba a 360 px.
    if (historial.scrollHeight > 0) conversacionPintada.current = detalle?.id ?? null;
  }, [mensajes, detalle?.id]);

  /**
   * Y cuando el panel PASA a ser visible, bajar (#581).
   *
   * El efecto de arriba corre cuando cambian los mensajes, no cuando el panel
   * aparece. En celular eso son dos momentos distintos: se toca la conversación,
   * el panel se muestra, y para entonces los mensajes ya estaban. Sin esto, abrir
   * una conversación desde el teléfono te deja en el primer mensaje del hilo.
   */
  useEffect(() => {
    const historial = historialRef.current;
    if (!historial || typeof ResizeObserver === 'undefined') return;
    const observador = new ResizeObserver(() => {
      if (historial.scrollHeight === 0) return;
      if (conversacionPintada.current === (detalle?.id ?? null)) return;
      conversacionPintada.current = detalle?.id ?? null;
      historial.scrollTop = historial.scrollHeight;
      estabaAbajo.current = true;
    });
    observador.observe(historial);
    return () => observador.disconnect();
  }, [detalle?.id]);

  /**
   * La ventana de 24 h, y arrastrar y pegar (#561).
   *
   * Van ARRIBA del `return` de «elige una conversación», y esa posición es la
   * corrección: abajo, `useArrastre` quedaba después de un return condicional,
   * así que al elegir la primera conversación React pasaba de N a N+1 hooks y
   * reventaba el panel entero — en blanco, sin mensajes ni campo de texto. La
   * suite E2E lo cazó; ninguna de mis guardas de fuente puede verlo.
   *
   * Fuera de la ventana queda apagado: ahí solo salen plantillas, y aceptar que
   * sueltes una foto que no va a salir es prometer algo que el canal no permite.
   */
  const enVentana = detalle ? ventanaAbierta(detalle) : false;
  const arrastre = useArrastre({ alRecibir: setArchivo, activo: enVentana });

  if (!detalle) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="rotulo">Bandeja</p>
        <p className="max-w-xs text-body">Elige una conversación de la lista para atenderla aquí.</p>
        <Button variant="secundario" size="chico" className="mt-2 lg:hidden" onClick={onVolver}>
          <IconoVolver className="h-4 w-4" /> Ver la lista
        </Button>
      </div>
    );
  }

  // Ni un tipo MIME escrito a mano acá: si la ruta no contestó, no se pone
  // `accept` y el selector deja elegir cualquier cosa — que es como estaba
  // antes y sigue teniendo su rechazo del lado del servidor.
  const aceptados = limitesDeAdjunto?.limites.flatMap((l) => l.tipos).join(',') ?? null;
  const aprobadas = (plantillas ?? []).filter((p) => p.status === 'approved');
  const cronologicos = mensajes ? [...mensajes].reverse() : [];

  async function enviar(e: FormEvent) {
    e.preventDefault();
    // Con archivo, el texto es opcional: una foto sola es un mensaje
    // completo, y exigir un pie obliga a escribir "mira" para poder mandarla.
    if ((!texto.trim() && !archivo) || enviando) return;
    setEnviando(true);
    const enviado = texto.trim();
    const adjunto = archivo;
    // La caja se vacía AL INSTANTE (#671), junto con el mensaje que aparece en el
    // hilo. Antes se limpiaba recién al volver el servidor, y con el mensaje ya
    // dibujado el mismo texto quedaba en DOS lugares a la vez —en la conversación
    // y en el campo—, que se ve como si se hubiera escrito dos veces. Lo cazó una
    // prueba: `resolved to 2 elements`.
    setTexto('');
    setArchivo(null);
    try {
      // Y si NO salió, se devuelve lo escrito. Perder lo redactado porque
      // WhatsApp cerró la ventana obliga a escribirlo de nuevo, y eso pasa a
      // diario (#560). Solo se repone si el campo sigue vacío: si alcanzó a
      // escribir otra cosa mientras tanto, lo suyo manda.
      if (!(await onResponder(enviado, adjunto ?? undefined))) {
        setTexto((actual) => (actual === '' ? enviado : actual));
        setArchivo((actual) => actual ?? adjunto);
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      {/* El panel entero recibe lo que se suelte (#561): apuntar a un recuadro
          chico obliga a mirar dónde se suelta, que es justo lo que el gesto
          viene a evitar. `relative` es para el aviso de acá abajo. */}
      <div className="relative flex min-h-0 flex-1 flex-col" {...arrastre.props}>
        {arrastre.arrastrando && (
          <div
            // `pointer-events-none` es lo que hace que esto funcione: un
            // overlay que recibe eventos se come el `drop` del contenedor y el
            // archivo nunca llega.
            //
            // El velo va con `color-mix` sobre el token y no con `bg-bg/85`:
            // los colores de Pulso no están definidos por canales, así que el
            // modificador de opacidad NO emite nada y el aviso habría quedado
            // sin fondo, con el texto encima de los mensajes. Lo cazó la guarda
            // de #548 — el mismo patrón que usa el velo del diálogo.
            className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-bloque border-2 border-dashed border-action bg-[color-mix(in_srgb,var(--bg)_88%,transparent)]"
          >
            <p className="font-display text-seccion font-bold text-action-text">
              Suéltalo acá para adjuntarlo
            </p>
          </div>
        )}
      <header className="pulso-chat-header flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Button variant="fantasma" size="icono" className="lg:hidden" aria-label="Volver a la lista" onClick={onVolver}>
          <IconoVolver className="h-4 w-4" />
        </Button>
        <div className="pulso-chat-contact min-w-0 flex-1">
          <p className="truncate font-display font-bold text-ink">
            {detalle.contactName ?? detalle.contactPhone}
          </p>
          <p className="dato truncate text-muted">{detalle.contactPhone}</p>
        </div>
        {modo !== null && modo !== 'off' && (
          <Button
            variant={modo === 'autonomous' ? 'primario' : 'secundario'}
            size="chico"
            data-testid="piloto-automatico"
            aria-pressed={modo === 'autonomous'}
            title={
              modo === 'autonomous'
                ? 'La IA responde sola en esta conversación. Toca para retomar el control.'
                : 'La IA solo sugiere. Toca para dejarla responder sola AQUÍ.'
            }
            onClick={() => onModo(modo === 'autonomous' ? 'assist' : 'autonomous')}
          >
            <Bot className="size-3.5" aria-hidden />{' '}
            {modo === 'autonomous' ? 'Piloto automático' : 'Copiloto'}
          </Button>
        )}
        <Badge role={ESTADOS[detalle.state].role}>{ESTADOS[detalle.state].label}</Badge>
        {/* La prioridad, solo si NO es normal (#550): una lista donde todo
            tiene etiqueta es una lista sin etiquetas. Y el color no va solo —
            la insignia lleva la palabra. */}
        {insigniaDePrioridad(detalle.priority) && (
          <Badge role={insigniaDePrioridad(detalle.priority)!.role}>
            {insigniaDePrioridad(detalle.priority)!.label}
          </Badge>
        )}
        <Button variant="secundario" size="chico" className="lg:hidden" onClick={onVerFicha}>
          <IconoPersona className="h-4 w-4" /> Ficha
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secundario" size="chico" data-testid="acciones">
              Acciones <IconoChevronAbajo className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Conversación</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void onAsignar(miId, 'la tomó desde la bandeja')}>
              Asignármela
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialogoAsignar(true)}>
              Asignar a otra persona…
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="cobrar" onSelect={() => setDialogoCobrar(true)}>
              Cobrar con link de pago…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Prioridad (#550). Cada opción dice qué significa: sin eso,
                «alta» y «urgente» terminan queriendo decir lo mismo y la
                prioridad deja de ordenar nada. */}
            <DropdownMenuLabel>Prioridad</DropdownMenuLabel>
            {PRIORIDADES.map((p) => (
              <DropdownMenuItem
                key={p.valor}
                data-testid={`prioridad-${p.valor}`}
                disabled={detalle.priority === p.valor}
                onSelect={() => void onPrioridad(p.valor)}
              >
                <span className="flex min-w-0 flex-col">
                  <span>
                    {p.label}
                    {detalle.priority === p.valor && ' · ahora'}
                  </span>
                  <span className="text-rotulo text-muted">{p.ayuda}</span>
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {detalle.state === 'resolved' ? (
              <DropdownMenuItem onSelect={() => void onEstado('open')}>Reabrir</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => void onEstado('pending')}>
                  Esperando al cliente
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="resolver" onSelect={() => void onEstado('resolved')}>
                  Resolver
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div
        ref={historialRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6"
        // Se anota si estás abajo en CADA scroll, no al llegar el mensaje: para
        // cuando llega ya es tarde —el contenido creció y la cuenta da que no
        // estabas—. 120 px de margen porque «abajo» no es el píxel exacto.
        onScroll={(e) => {
          const el = e.currentTarget;
          estabaAbajo.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {/* Leer hacia atrás (#581). Antes se veían los últimos 50 y ahí se
            terminaba: una conversación de tres meses mostraba su último pedazo
            y el resto no estaba al alcance de nadie —ni de quien toma una
            conversación que atendía otra persona y necesita ver qué se le
            prometió al cliente, ni del copiloto, que arma su contexto con lo
            que hay—. */}
        {hayAnteriores && (
          <div className="mb-4 flex justify-center">
            <Button
              variant="secundario"
              size="chico"
              disabled={trayendoAnteriores}
              onClick={() => {
                // Se anota el alto ANTES de pedir: cuando lleguen, el efecto
                // empuja el scroll lo mismo que creció y no se pierde el lugar.
                altoAntes.current = historialRef.current?.scrollHeight ?? null;
                void onVerAnteriores?.();
              }}
            >
              {trayendoAnteriores ? 'Trayendo…' : 'Ver mensajes anteriores'}
            </Button>
          </div>
        )}
        <ol className="mx-auto flex max-w-2xl flex-col gap-3">
          {cronologicos.map((m) => (
            <li
              key={m.id}
              className={cn('pulso-entrada flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-tarjeta px-4 py-2.5',
                  m.direction === 'out'
                    ? 'rounded-br-campo border border-action-soft-br bg-action-soft'
                    : 'rounded-bl-campo border border-line bg-raised',
                )}
              >
                {m.authorKind === 'agent' && (
                  <p className="rotulo mb-1">Respondió el asistente</p>
                )}
                <p className="whitespace-pre-wrap text-cuerpo text-ink">{m.body}</p>
                {/* Abrir lo que mandó el cliente (#460). Se guardan en R2
                    desde #42 —Meta los expira, por eso se bajan al llegar—
                    y la bandeja no los mostraba: un mensaje con foto se
                    veía vacío, y la foto era todo el mensaje. */}
                {(m.lostAttachments ?? 0) > 0 && (
                  <p className="mt-2 text-rotulo text-muted">
                    {m.lostAttachments === 1
                      ? 'Llegó un archivo que no alcanzamos a guardar; pídeselo de nuevo.'
                      : `Llegaron ${m.lostAttachments} archivos que no alcanzamos a guardar; pídeselos de nuevo.`}
                  </p>
                )}
                {/* `?? []` y no `.length` a secas: la bandeja también se
                    dibuja con mensajes que no vienen de esta API —las
                    pruebas de navegador los sirven a mano—, y un campo que
                    falte no puede dejar en blanco la conversación entera. */}
                {(m.attachments ?? []).length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1">
                    {(m.attachments ?? []).map((a) => (
                      <li key={a.key}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-campo border border-line bg-rest px-3 py-2 text-left text-sm text-body hover:bg-raised"
                          onClick={() => onAbrirAdjunto(a.key)}
                        >
                          <Paperclip aria-hidden className="size-4 shrink-0" />
                          <span className="truncate">{a.name}</span>
                          <span className="ml-auto shrink-0 text-rotulo text-muted">Abrir</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 flex items-center justify-end gap-1">
                  <HoraDato iso={m.createdAt} />
                  {m.direction === 'out' && <Entrega estado={m.deliveryStatus} />}
                </p>
                {/* Un mensaje que no llegó es una conversación perdida
                    (#445). La recuperación existe desde #380 y retoma el
                    MISMO pedido —no crea otro mensaje, así que no duplica
                    si en realidad sí había salido— y no la llamaba nadie:
                    la bandeja mostraba el ícono rojo y ninguna acción. */}
                {m.direction === 'out' && m.deliveryStatus === 'failed' && (
                  <div className="mt-1 flex flex-col items-end gap-1">
                    {/* El motivo, que estaba escrito en la base desde siempre y
                        no se mostraba (#645): la bandeja decía «No llegó» y
                        ofrecía reintentar, once veces, mientras la frase que lo
                        explicaba esperaba en `meta.error`. */}
                    <span className="text-rotulo text-bad-text">
                      {m.error ? `No llegó. ${m.error}` : 'No llegó.'}
                    </span>
                    {enVentana ? (
                      <Button
                        size="chico"
                        variant="secundario"
                        disabled={reintentando === m.id}
                        onClick={() => void onReintentar(m.id)}
                      >
                        {reintentando === m.id ? 'Reintentando…' : 'Reintentar'}
                      </Button>
                    ) : (
                      /* Con la ventana cerrada, reintentar un mensaje libre
                         falla SIEMPRE, por definición. Un botón que garantiza
                         fallar es peor que no tener botón: invita a gastar el
                         intento de nuevo. Lo que sí sirve es la plantilla, y
                         el selector ya está abajo reemplazando al campo. */
                      <span className="text-rotulo text-muted">
                        Reintentar no va a servir hasta que te escriba: mándale una plantilla.
                      </span>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {aviso && (
        <AvisoResultado>
          {aviso.texto}
          {aviso.rastro && (
            /* El identificador, para pedir ayuda (#659). La API lo manda en
               toda respuesta de error y se descartaba, así que la pantalla
               decía «ya quedó registrado» sin dar con qué. Va en mono porque
               es un identificador (ui-pulso.md), discreto porque quien atiende
               lee la frase, y CON su botón: desde un teléfono seleccionar texto
               chico es imposible, y la bandeja se usa desde el teléfono. */
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <span className="dato text-rotulo text-muted">{aviso.rastro}</span>
              <button
                type="button"
                className="text-rotulo text-action-text underline"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(aviso.rastro ?? '')
                    .then(() => toast.success('Copiado. Pásalo para que puedan buscarlo.'))
                    .catch(() => toast.error('Tu navegador no dejó copiar. Selecciónalo a mano.'));
                }}
              >
                Copiar
              </button>
            </span>
          )}
        </AvisoResultado>
      )}


      {/* Por qué no hay sugerencia (#436). Solo cuando el copiloto está
          encendido: con el módulo apagado no falta nada, y explicar la
          ausencia de algo que nadie contrató sería ruido.
          `todavia_trabajando` tampoco se muestra: el copiloto corre después
          del camino de entrada a propósito, y avisar de eso en cada mensaje
          convertiría lo normal en una alarma. */}
      {!sugerencia && sinSugerencia && modo !== null && modo !== 'off' &&
        sinSugerencia.codigo !== 'todavia_trabajando' && (
        <div className="mx-4 mb-2 rounded-campo border border-line bg-rest p-3">
          <p className="rotulo">Sin sugerencia del asistente</p>
          <p className="mt-1 text-sm text-body">{sinSugerencia.texto}</p>
          {sinSugerencia.queHacer && (
            <p className="mt-1 text-sm text-muted">{sinSugerencia.queHacer}</p>
          )}
        </div>
      )}

      {/* El copiloto (#48): aviso action-soft sobre el campo — UN toque. */}
      {/* Lo que se va a mandar, visible y quitable: un archivo elegido por
          error y no visto sale igual. */}
      {archivo && enVentana && (
        <p className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-campo border border-line bg-rest px-3 py-2 text-sm text-body">
          <Paperclip aria-hidden className="size-3.5 text-muted" />
          <span className="min-w-0 flex-1 truncate">{archivo.name}</span>
          <span className="text-rotulo text-muted">{Math.ceil(archivo.size / 1024)} KB</span>
          {/* El tope de SU clase, no uno genérico (#560): «máx. 100 MB» junto a
              una foto de 6 MB que no va a salir es peor que no decir nada. */}
          {(() => {
            const tipo = (archivo.type || '').split(';')[0]!.toLowerCase();
            const suyo = limitesDeAdjunto?.limites.find((l) => l.tipos.includes(tipo));
            if (!suyo) return null;
            return (
              <span className="text-rotulo text-muted">
                máx. {Math.round(suyo.maxBytes / (1024 * 1024))} MB
              </span>
            );
          })()}
          <Button variant="fantasma" size="chico" onClick={() => setArchivo(null)}>
            Quitar
          </Button>
        </p>
      )}

      {sugerencia && enVentana && (
        <div className="mx-4 mb-2 rounded-campo border border-action-soft-br bg-action-soft p-3">
          <p className="rotulo">Sugerencia del asistente{sugerencia.confidence !== null && ` · ${Math.round(sugerencia.confidence * 100)} %`}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{sugerencia.text}</p>
          <EnQueSeApoyo herramientas={sugerencia.herramientas} />
          {sugerencia.suggestDeal && detalle && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-action-text">
              Parece que quiere cotizar —
              <Button
                variant="soft"
                size="chico"
                onClick={() =>
                  void onCrearOportunidad(
                    `${sugerencia.intent === 'agendar' ? 'Agendamiento' : 'Cotización'} · ${detalle.contactName ?? detalle.contactPhone}`,
                  )
                }
              >
                Crear la oportunidad
              </Button>
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="chico" data-testid="enviar-sugerencia" onClick={() => void onSugerencia('send')}>
              Enviar sugerencia
            </Button>
            <Button variant="fantasma" size="chico" onClick={() => void onSugerencia('dismiss')}>
              Descartar
            </Button>
            <span className="ml-auto flex items-center gap-1">
              <Button
                variant="fantasma"
                size="icono"
                aria-label="La sugerencia sirvió"
                onClick={() => void onSugerencia('feedback', { feedback: 'up' })}
              >
                <ThumbsUp className="size-4" aria-hidden />
              </Button>
              <Button
                variant="fantasma"
                size="icono"
                aria-label="La sugerencia no sirvió"
                onClick={() => setMotivoAbajo((v) => !v)}
              >
                <ThumbsDown className="size-4" aria-hidden />
              </Button>
            </span>
          </div>
          {motivoAbajo && (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void onSugerencia('feedback', { feedback: 'down', reason: motivoFeedback.trim() || undefined }).then(() => {
                  setMotivoAbajo(false);
                  setMotivoFeedback('');
                });
              }}
            >
              <Input
                aria-label="Qué estuvo mal"
                placeholder="¿Qué estuvo mal? (opcional)"
                className="h-9 text-sm"
                value={motivoFeedback}
                onChange={(e) => setMotivoFeedback(e.target.value)}
              />
              <Button type="submit" variant="secundario" size="chico">Enviar</Button>
            </form>
          )}
        </div>
      )}
      {/* Fuera de la ventana de 24 h el campo se reemplaza por el selector de
          plantillas (SPEC §11); llega con los canales reales en Fase 3. */}
      {enVentana ? (
        <form onSubmit={enviar} className="flex items-end gap-2 border-t border-line p-4">
          {atajos.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secundario" size="icono" aria-label="Atajos de respuesta" className="h-control w-11">
                  /
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuLabel>Atajos</DropdownMenuLabel>
                {atajos.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={() =>
                      setTexto((previo) =>
                        (previo ? `${previo} ` : '') +
                        renderQuickReply(a.body, {
                          nombre: detalle.contactName,
                          telefono: detalle.contactPhone,
                        }),
                      )
                    }
                  >
                    <span className="dato mr-2 text-muted">/{a.shortcut}</span>
                    <span className="max-w-56 truncate">{a.body}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Adjuntar (#458). Antes el camino entero existía sin puerta:
              la URL prefirmada, el campo en el mensaje y el tipo del
              adaptador. Lo que faltaba era esto y que el adaptador lo
              tradujera. */}
          <label className="flex h-control w-11 shrink-0 cursor-pointer items-center justify-center rounded-boton border border-line-strong text-body hover:bg-rest">
            <Paperclip aria-hidden className="size-4" />
            <span className="sr-only">Adjuntar un archivo</span>
            <input
              type="file"
              className="hidden"
              // Los tipos salen de la tabla del canal (#560): que el selector
              // ni ofrezca un .exe es mejor que rechazarlo después. Es una
              // pista y no la cerradura — la cerradura está en la ruta que
              // firma la subida, y es la que manda.
              {...(aceptados ? { accept: aceptados } : {})}
              onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
            />
          </label>
          <Textarea
            aria-label="Mensaje"
            placeholder="Escribe tu respuesta…"
            rows={1}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            // Pegar una captura la adjunta (#561); pegar texto sigue pegando
            // texto, que es lo que pasa el 99 % de las veces.
            onPaste={arrastre.alPegar}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void enviar(e);
              }
            }}
            className="max-h-40"
          />
          <Button type="submit" size="icono" aria-label="Enviar" disabled={(!texto.trim() && !archivo) || enviando} className="h-control w-11">
            <IconoEnviar className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <div className="border-t border-line p-4">
          <Button
            variant="soft"
            className="w-full"
            onClick={() => {
              setDialogoPlantilla(true);
              if (plantillas === null) void onCargarPlantillas();
            }}
          >
            Elegir plantilla — pasaron más de 24 h desde su último mensaje
          </Button>
          <p className="mt-2 text-center text-xs text-muted">
            Pasadas 24 horas desde su último mensaje, WhatsApp solo deja escribir con una
            plantilla que Meta aprobó.
          </p>
        </div>
      )}

      {/* Elegir plantilla (#460).
          La ruta existía desde #44 y el botón estaba DESHABILITADO con un
          texto que decía que las plantillas llegaban "con la conexión real".
          Ya habían llegado: lo que faltaba era esto, y sin esto, pasadas las
          24 h, quien atiende no le podía escribir a nadie. */}
      <Dialog open={dialogoPlantilla} onOpenChange={(abierto) => {
        setDialogoPlantilla(abierto);
        if (!abierto) { setElegida(null); setValores([]); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{elegida ? elegida.name : 'Elegir una plantilla'}</DialogTitle>
            <DialogDescription>
              {elegida
                ? 'Completa lo que cambia en cada envío. Así es como lo va a leer.'
                : 'Solo aparecen las que Meta aprobó: una en revisión falla en el proveedor y la persona nunca la recibe.'}
            </DialogDescription>
          </DialogHeader>

          {plantillas === null ? (
            <p className="py-4 text-sm text-muted">Buscando las plantillas del negocio…</p>
          ) : elegida === null ? (
            aprobadas.length === 0 ? (
              <div className="flex flex-col gap-2 py-2">
                <p className="text-sm text-body">
                  Todavía no hay ninguna plantilla aprobada. Meta se demora en revisarlas, así que
                  conviene tenerlas antes de necesitarlas.
                </p>
                <a href="/ajustes/plantillas" className="text-sm font-medium text-action-text underline">
                  Ir a Plantillas de WhatsApp
                </a>
              </div>
            ) : (
              <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto py-1">
                {aprobadas.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="w-full rounded-tarjeta border border-line bg-raised p-3 text-left hover:bg-rest"
                      onClick={() => {
                        setElegida(p);
                        setValores(Array.from({ length: cuantasVariables(p) }, () => ''));
                      }}
                    >
                      <span className="dato text-sm text-ink">{p.name}</span>
                      <span className="ml-2 text-xs text-muted">{p.language}</span>
                      <p className="mt-1 line-clamp-2 text-sm text-body">{p.body}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="flex flex-col gap-3 py-1">
              {variablesDePlantilla(elegida.body).map((n, i) => (
                <label key={n} className="flex flex-col gap-1 text-sm text-body">
                  Valor de {`{{${n}}}`}
                  <Input
                    value={valores[i] ?? ''}
                    onChange={(e) => {
                      const nuevo = [...valores];
                      nuevo[i] = e.target.value;
                      setValores(nuevo);
                    }}
                  />
                  <span className="flex gap-2">
                    {[
                      { etiqueta: 'Su nombre', valor: detalle.contactName },
                      { etiqueta: 'Su teléfono', valor: detalle.contactPhone },
                    ]
                      .filter((c) => Boolean(c.valor))
                      .map((c) => (
                        <Button
                          key={c.etiqueta}
                          type="button"
                          variant="fantasma"
                          size="chico"
                          onClick={() => {
                            const nuevo = [...valores];
                            nuevo[i] = c.valor as string;
                            setValores(nuevo);
                          }}
                        >
                          {c.etiqueta}
                        </Button>
                      ))}
                  </span>
                </label>
              ))}
              <div className="rounded-tarjeta border border-line bg-rest p-3">
                <p className="rotulo mb-1">Así llega</p>
                <p className="whitespace-pre-wrap text-sm text-body">
                  {renderPlantilla(elegida.body, valores)}
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            {elegida && (
              <Button variant="fantasma" onClick={() => { setElegida(null); setValores([]); }}>
                Ver las otras
              </Button>
            )}
            <Button variant="secundario" onClick={() => setDialogoPlantilla(false)}>Cancelar</Button>
            {elegida && (
              <Button
                disabled={mandandoPlantilla || valores.some((v) => !v.trim())}
                onClick={async () => {
                  setMandandoPlantilla(true);
                  try {
                    await onEnviarPlantilla(elegida.id, valores);
                    setDialogoPlantilla(false);
                    setElegida(null);
                    setValores([]);
                  } finally {
                    setMandandoPlantilla(false);
                  }
                }}
              >
                {mandandoPlantilla ? 'Enviando…' : 'Enviar la plantilla'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogoCobrar} onOpenChange={setDialogoCobrar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cobrar con link de pago</DialogTitle>
            <DialogDescription>
              El link llega al chat y te avisamos apenas paguen. Los montos van en pesos.
            </DialogDescription>
          </DialogHeader>
          <label className="mt-2 flex flex-col gap-1 text-sm text-body">
            Monto (CLP)
            <Input
              type="number"
              min={1}
              step={1000}
              className="dato"
              value={montoCobro}
              onChange={(e) => setMontoCobro(e.target.value)}
              placeholder="45000"
            />
          </label>
          <label className="mt-3 flex flex-col gap-1 text-sm text-body">
            Concepto
            <Input
              value={conceptoCobro}
              onChange={(e) => setConceptoCobro(e.target.value)}
              placeholder="Ej: Manicure gel + retiro"
            />
          </label>
          <DialogFooter>
            <Button variant="secundario" onClick={() => setDialogoCobrar(false)}>Cancelar</Button>
            <Button
              data-testid="enviar-cobro"
              disabled={!(Number(montoCobro) > 0) || !conceptoCobro.trim()}
              onClick={async () => {
                await onCobrar(Number(montoCobro), conceptoCobro.trim());
                setDialogoCobrar(false);
                setMontoCobro('');
                setConceptoCobro('');
              }}
            >
              Crear y enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogoAsignar} onOpenChange={setDialogoAsignar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Asignar la conversación</DialogTitle>
            <DialogDescription>
              El selector de equipo llega con la asignación automática; por ahora pega el ID de la
              persona.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              aria-label="ID de la persona"
              placeholder="ID de la persona"
              value={aQuien}
              onChange={(e) => setAQuien(e.target.value)}
            />
            <Input
              aria-label="Motivo"
              placeholder="Motivo (queda en la historia)"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="secundario" onClick={() => setDialogoAsignar(false)}>Cancelar</Button>
            <Button
              disabled={!aQuien.trim()}
              onClick={() => {
                void onAsignar(aQuien.trim(), motivo.trim() || undefined).then(() => {
                  setDialogoAsignar(false);
                  setAQuien('');
                  setMotivo('');
                });
              }}
            >
              Asignar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </>
  );
}
