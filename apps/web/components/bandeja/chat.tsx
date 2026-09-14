'use client';

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
import { enVentana24h, renderQuickReply, type ConversacionDetalle, type Mensaje, type QuickReplyDto } from '../../lib/api';
import { ESTADOS } from './estado';

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
  miId: string;
  aviso: string | null;
  onVolver: () => void;
  onVerFicha: () => void;
  onResponder: (texto: string) => Promise<void>;
  onAsignar: (aQuien: string, motivo?: string) => Promise<void>;
  onEstado: (estado: string, hasta?: string) => Promise<void>;
}

export function Chat({
  detalle, mensajes, atajos, miId, aviso,
  onVolver, onVerFicha, onResponder, onAsignar, onEstado,
}: ChatProps) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [dialogoAsignar, setDialogoAsignar] = useState(false);
  const [aQuien, setAQuien] = useState('');
  const [motivo, setMotivo] = useState('');
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    finRef.current?.scrollIntoView({ block: 'end' });
  }, [mensajes]);

  if (!detalle) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="rotulo">Bandeja</p>
        <p className="max-w-xs text-body">Elige una conversación de la lista para atenderla aquí.</p>
        <Button variant="secundario" size="chico" className="mt-2 md:hidden" onClick={onVolver}>
          <IconoVolver className="h-4 w-4" /> Ver la lista
        </Button>
      </div>
    );
  }

  const enVentana = enVentana24h(detalle.lastInboundAt);
  const cronologicos = mensajes ? [...mensajes].reverse() : [];

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!texto.trim() || enviando) return;
    setEnviando(true);
    try {
      await onResponder(texto.trim());
      setTexto('');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Button variant="fantasma" size="icono" className="md:hidden" aria-label="Volver a la lista" onClick={onVolver}>
          <IconoVolver className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display font-bold text-ink">
            {detalle.contactName ?? detalle.contactPhone}
          </p>
          <p className="dato text-muted">{detalle.contactPhone}</p>
        </div>
        <Badge role={ESTADOS[detalle.state].role}>{ESTADOS[detalle.state].label}</Badge>
        <Button variant="secundario" size="chico" className="md:hidden" onClick={onVerFicha}>
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

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <ol className="mx-auto flex max-w-2xl flex-col gap-3">
          {cronologicos.map((m) => (
            <li
              key={m.id}
              className={cn('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}
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
                <p className="whitespace-pre-wrap text-[15px] text-ink">{m.body}</p>
                <p className="mt-1 flex items-center justify-end gap-1">
                  <HoraDato iso={m.createdAt} />
                  {m.direction === 'out' && <Entrega estado={m.deliveryStatus} />}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div ref={finRef} />
      </div>

      {aviso && (
        <p role="alert" className="mx-4 mb-2 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-2 text-sm text-warn-text">
          {aviso}
        </p>
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
          <Button type="submit" size="icono" aria-label="Enviar" disabled={!texto.trim() || enviando} className="h-control w-11">
            <IconoEnviar className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <div className="border-t border-line p-4">
          <Button variant="soft" disabled className="w-full">
            Elegir plantilla — pasaron más de 24 h desde su último mensaje
          </Button>
          <p className="mt-2 text-center text-xs text-muted">
            Las plantillas aprobadas llegan con la conexión real de WhatsApp.
          </p>
        </div>
      )}

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
