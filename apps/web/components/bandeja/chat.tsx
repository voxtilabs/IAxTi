'use client';

import { AvisoResultado } from '@iaxti/ui/react';

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
} from '@iaxti/ui/react';
import {
  enVentana24h,
  renderPlantilla,
  renderQuickReply,
  variablesDePlantilla,
  type ConversacionDetalle,
  type Mensaje,
  type PlantillaDto,
  type QuickReplyDto,
  type SugerenciaDto,
} from '../../lib/api';
import { ESTADOS } from './estado';

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
  aviso: string | null;
  onVolver: () => void;
  onVerFicha: () => void;
  /** Responde. El adjunto es opcional: una foto sola ya es un mensaje (#458). */
  onResponder: (texto: string, adjunto?: File) => Promise<void>;
  onAsignar: (aQuien: string, motivo?: string) => Promise<void>;
  onEstado: (estado: string, hasta?: string) => Promise<void>;
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
}

export function Chat({
  detalle, mensajes, atajos, sugerencia, sinSugerencia, modo, miId, aviso,
  onReintentar, reintentando,
  onVolver, onVerFicha, onResponder, onAsignar, onEstado, onSugerencia, onModo, onCobrar, onCrearOportunidad,
  plantillas, onCargarPlantillas, onEnviarPlantilla,
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

  useEffect(() => {
    const historial = historialRef.current;
    if (historial) historial.scrollTop = historial.scrollHeight;
  }, [mensajes]);

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

  const enVentana = enVentana24h(detalle.lastInboundAt);
  const aprobadas = (plantillas ?? []).filter((p) => p.status === 'approved');
  const cronologicos = mensajes ? [...mensajes].reverse() : [];

  async function enviar(e: FormEvent) {
    e.preventDefault();
    // Con archivo, el texto es opcional: una foto sola es un mensaje
    // completo, y exigir un pie obliga a escribir "mira" para poder mandarla.
    if ((!texto.trim() && !archivo) || enviando) return;
    setEnviando(true);
    try {
      await onResponder(texto.trim(), archivo ?? undefined);
      setTexto('');
      setArchivo(null);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
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

      <div ref={historialRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6">
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
                  <p className="mt-1 flex flex-wrap items-center justify-end gap-2">
                    <span className="text-micro text-bad-text">No llegó.</span>
                    <Button
                      size="chico"
                      variant="secundario"
                      disabled={reintentando === m.id}
                      onClick={() => void onReintentar(m.id)}
                    >
                      {reintentando === m.id ? 'Reintentando…' : 'Reintentar'}
                    </Button>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {aviso && (
        <AvisoResultado>
          {aviso}
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
          <span className="text-micro text-muted">{Math.ceil(archivo.size / 1024)} KB</span>
          <Button variant="fantasma" size="chico" onClick={() => setArchivo(null)}>
            Quitar
          </Button>
        </p>
      )}

      {sugerencia && enVentana && (
        <div className="mx-4 mb-2 rounded-campo border border-action-soft-br bg-action-soft p-3">
          <p className="rotulo">Sugerencia del asistente{sugerencia.confidence !== null && ` · ${Math.round(sugerencia.confidence * 100)} %`}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{sugerencia.text}</p>
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
              onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
            />
          </label>
          <Textarea
            aria-label="Mensaje"
            placeholder="Escribe tu respuesta…"
            rows={1}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
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
    </>
  );
}
