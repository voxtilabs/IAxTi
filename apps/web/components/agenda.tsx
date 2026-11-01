'use client';

import { AvisoResultado, EncabezadoDePagina, Seccion } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, Input, Skeleton, useSession, type BadgeRole,
} from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { useArranque } from './arranque';
import { GoogleCalendarConnection } from './google-calendar';
import { RecordatoriosDeCita } from './recordatorios-de-cita';
import { HorariosDeAtencion } from './horarios-de-atencion';
import { DarUnaHora } from './dar-una-hora';
import { PorQueSeCancelan } from './por-que-se-cancelan';
import { apiFetch, avisoDe, type CitaDto, mensajeDeError } from '../lib/api';

// La agenda (#58, SPEC §16): las citas de la semana y qué pasó con cada una.
//
// La API existía completa —disponibilidad, huecos, agendar, cambiar estado—
// y no había pantalla: el manifiesto ofrecía "Agenda" en el menú y llevaba a
// un 404.
//
// Lo que se puede hacer acá sale de la MÁQUINA DE ESTADOS del dominio, no de
// lo que a mí me parezca: una cita atendida no "se arregla" cambiándole el
// estado, se agenda otra. Si el dominio lo prohíbe, el botón no está.

const ETIQUETA: Record<CitaDto['status'], { texto: string; rol: BadgeRole }> = {
  proposed: { texto: 'Propuesta', rol: 'warn' },
  confirmed: { texto: 'Confirmada', rol: 'action' },
  reminded: { texto: 'Avisada', rol: 'action' },
  attended: { texto: 'Vino', rol: 'good' },
  no_show: { texto: 'No llegó', rol: 'bad' },
  cancelled: { texto: 'Cancelada', rol: 'neutral' },
  rescheduled: { texto: 'Reagendada', rol: 'neutral' },
};

/**
 * Las mismas transiciones que `domain/estado.ts` permite.
 *
 * Duplicarlas acá es una copia, y las copias se desincronizan. Pero la
 * alternativa —pedirle al servidor qué botones mostrar— es un viaje de ida y
 * vuelta por cada fila. El servidor sigue siendo quien manda: si esta lista
 * se equivoca, la API rechaza igual y el aviso lo dice.
 */
/**
 * Dónde aparece «Mover» (#836).
 *
 * Los mismos tres que el caso de uso acepta. Una cita cancelada o que ya
 * ocurrió no se mueve —mover una `attended` reescribiría cuándo pasó algo que
 * pasó—, y mostrar un botón que el servidor va a rechazar es peor que no
 * mostrarlo: enseña que el producto falla donde en realidad está cuidando algo.
 */
const SE_PUEDE_MOVER = new Set<CitaDto['status']>(['proposed', 'confirmed', 'reminded']);

const SIGUIENTES: Record<CitaDto['status'], Array<{ a: CitaDto['status']; texto: string }>> = {
  proposed: [
    { a: 'confirmed', texto: 'Confirmar' },
    { a: 'cancelled', texto: 'Cancelar' },
  ],
  confirmed: [
    { a: 'attended', texto: 'Vino' },
    { a: 'no_show', texto: 'No llegó' },
    { a: 'cancelled', texto: 'Cancelar' },
  ],
  reminded: [
    { a: 'attended', texto: 'Vino' },
    { a: 'no_show', texto: 'No llegó' },
    { a: 'cancelled', texto: 'Cancelar' },
  ],
  attended: [],
  no_show: [],
  cancelled: [],
  rescheduled: [],
};

function dia(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

export function Agenda() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const { arranque } = useArranque();
  const puedeAgendar = Boolean(arranque?.permisos?.includes('calendar.book'));
  const [citas, setCitas] = useState<CitaDto[] | null>(null);
  const [porCancelar, setPorCancelar] = useState<CitaDto | null>(null);
  const [porMover, setPorMover] = useState<CitaDto | null>(null);
  const [nuevaHora, setNuevaHora] = useState('');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [moviendo, setMoviendo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const desde = new Date();
      desde.setHours(0, 0, 0, 0);
      const hasta = new Date(desde.getTime() + 14 * 24 * 3600_000);
      const r = await apiFetch<CitaDto[]>(
        config,
        session,
        tenant,
        `/agenda?desde=${desde.toISOString()}&hasta=${hasta.toISOString()}`,
      );
      setCitas(r);
      setError(null);
    } catch (e) {
      setError(mensajeDeError(e));
      setCitas([]);
    }
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function cambiar(cita: CitaDto, a: CitaDto['status'], motivo?: string) {
    if (!session || !tenant || moviendo) return;
    setMoviendo(cita.id);
    try {
      await apiFetch(config, session, tenant, `/agenda/${cita.id}/estado`, {
        method: 'POST',
        body: JSON.stringify(motivo ? { estado: a, motivo } : { estado: a }),
      });
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setMoviendo(null);
    }
  }

  /**
   * Mover la hora (#836).
   *
   * Se conserva el LARGO de la cita: quien la corre media hora no está
   * cambiando cuánto dura, y pedir las dos puntas sería pedir dos datos para
   * mover uno. Si algún día hace falta cambiar la duración, es otra cosa y
   * merece su propio control.
   */
  async function mover(cita: CitaDto, inicio: Date) {
    if (!session || !tenant || moviendo) return;
    const largoMs = new Date(cita.endsAt).getTime() - new Date(cita.startsAt).getTime();
    setMoviendo(cita.id);
    try {
      await apiFetch(config, session, tenant, `/agenda/${cita.id}/mover`, {
        method: 'POST',
        body: JSON.stringify({
          inicio: inicio.toISOString(),
          fin: new Date(inicio.getTime() + largoMs).toISOString(),
        }),
      });
      await cargar();
    } catch (e) {
      // El mensaje del servidor: cuando rechaza dice qué pasó —la hora se
      // acaba de tomar, la cita está cancelada— y eso es lo accionable.
      setError(avisoDe(e).texto);
    } finally {
      setMoviendo(null);
    }
  }

  /**
   * Cancelar pide el motivo (#700).
   *
   * `cancel_reason` existía desde el primer día y esta pantalla mandaba la
   * cancelación sin él: la columna solo se llenaba cuando cancelaba la IA. Así
   * que «¿por qué se nos cancelan las visitas?» no se podía contestar ni
   * leyendo la base — el dato no estaba.
   *
   * No es obligatorio: forzarlo haría que alguien escriba «x» para salir del
   * paso, y un motivo falso es peor que ninguno. Se ofrece, y lo que quede en
   * blanco se cuenta aparte como «sin motivo».
   */

  if (citas === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  // Agrupadas por día: una lista plana de catorce días no se lee.
  const porDia = new Map<string, CitaDto[]>();
  for (const c of [...citas].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const clave = c.startsAt.slice(0, 10);
    porDia.set(clave, [...(porDia.get(clave) ?? []), c]);
  }

  return (
    <section className="flex flex-col gap-6">
      <EncabezadoDePagina
        titulo="Agenda"
        apoyo="Las próximas dos semanas."
      />

      <GoogleCalendarConnection />

      {error && (
        <AvisoResultado tono="error">
          {error}
        </AvisoResultado>
      )}

      {porDia.size === 0 ? (
        /* Por `Seccion` y sin centrar (#1122). Era el único bloque de la
           pantalla con el texto al medio, entre dos que lo alinean a la
           izquierda: una alineación que cambia en el del medio es de las cosas
           que se leen como inacabado sin que nadie sepa nombrarlas. */
        <Seccion
          className="mt-0"
          titulo="Todavía no hay horas agendadas"
          apoyo={`Van a aparecer acá cuando alguien tome una hora — desde una conversación de la bandeja${puedeAgendar ? ' o cuando tú la agendes.' : '.'}`}
        />
      ) : (
        [...porDia.entries()].map(([clave, delDia]) => (
          <div key={clave} className="flex w-full max-w-seccion flex-col gap-2">
            <h2 className="text-sm font-medium capitalize text-muted">{dia(delDia[0].startsAt)}</h2>
            <ul className="flex flex-col gap-2">
              {delDia.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 pulso-panel rounded-tarjeta border border-line bg-raised px-4 py-3"
                >
                  <span className="dato text-base text-ink">
                    {hora(c.startsAt)}–{hora(c.endsAt)}
                  </span>
                  <a
                    href={`/contactos/${c.contactId}`}
                    className="min-w-0 flex-1 truncate text-sm text-action-text"
                  >
                    {c.title ?? 'Sin título'}
                  </a>
                  <Badge role={ETIQUETA[c.status].rol}>{ETIQUETA[c.status].texto}</Badge>
                  {/* Por qué se cayó (#700): se escribía y no se mostraba. */}
                  {c.status === 'cancelled' && c.cancelReason && (
                    <span className="w-full text-xs text-muted sm:w-auto">{c.cancelReason}</span>
                  )}
                  {/* Cancelada acá y viva en Google: ocupa una hora que el
                      vendedor ve libre, así que se dice en la cita. */}
                  {c.googleSyncError && (
                    <span className="w-full text-xs text-warn-text">{c.googleSyncError}</span>
                  )}
                  <span className="flex flex-wrap gap-2">
                    {puedeAgendar && SIGUIENTES[c.status].map((s) => (
                      <Button
                        key={s.a}
                        variant={s.a === 'cancelled' ? 'fantasma' : 'secundario'}
                        size="chico"
                        disabled={moviendo === c.id}
                        onClick={() =>
                          s.a === 'cancelled'
                            ? (setPorCancelar(c), setMotivo(''))
                            : void cambiar(c, s.a)
                        }
                      >
                        {s.texto}
                      </Button>
                    ))}
                    {/* Mover solo donde se puede: una cita cancelada o que ya
                        pasó no se mueve, se agenda otra (#836). El botón no
                        aparece en vez de aparecer y fallar. */}
                    {SE_PUEDE_MOVER.has(c.status) && (
                      <Button
                        variant="fantasma"
                        size="chico"
                        disabled={moviendo === c.id}
                        onClick={() => {
                          setPorMover(c);
                          // El campo arranca en la hora actual de la cita, en
                          // local: mover es corregir, no escribir de cero.
                          const d = new Date(c.startsAt);
                          const dos = (n: number) => String(n).padStart(2, '0');
                          setNuevaHora(
                            `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}`,
                          );
                        }}
                      >
                        Mover
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {/* La configuración va DESPUÉS de las horas: quien abre la agenda
          viene a ver qué tiene hoy, no a configurar. */}
      {/* Dar una hora va con las citas, no con la configuración: es
          trabajo del día, no un ajuste (#460). */}
      <Dialog open={porCancelar !== null} onOpenChange={(abierto) => !abierto && setPorCancelar(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar esta hora</DialogTitle>
            <DialogDescription>
              ¿Por qué se cayó? Queda en la cita y sirve para ver qué se repite. Puedes dejarlo en
              blanco.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Motivo de la cancelación"
            placeholder="El cliente avisó que no podía"
            maxLength={200}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
          <DialogFooter>
            <Button variant="secundario" onClick={() => setPorCancelar(null)}>
              Volver
            </Button>
            <Button
              onClick={() => {
                const cita = porCancelar;
                if (!cita) return;
                setPorCancelar(null);
                void cambiar(cita, 'cancelled', motivo.trim() || undefined);
              }}
            >
              Cancelar la hora
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={porMover !== null} onOpenChange={(abierto) => !abierto && setPorMover(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mover esta hora</DialogTitle>
            <DialogDescription>
              La cita es la misma y dura lo mismo: solo cambia cuándo. Si ya le habíamos recordado,
              se le vuelve a recordar para la hora nueva.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="datetime-local"
            aria-label="Nueva hora de la cita"
            value={nuevaHora}
            onChange={(e) => setNuevaHora(e.target.value)}
          />
          <DialogFooter>
            <Button variant="secundario" onClick={() => setPorMover(null)}>
              Volver
            </Button>
            <Button
              disabled={!nuevaHora}
              onClick={() => {
                const cita = porMover;
                if (!cita || !nuevaHora) return;
                setPorMover(null);
                void mover(cita, new Date(nuevaHora));
              }}
            >
              Mover la hora
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PorQueSeCancelan />
      {puedeAgendar && <DarUnaHora onAgendada={() => void cargar()} />}
      {arranque?.permisos?.includes('calendar.manage_availability') && <HorariosDeAtencion />}
      {arranque?.permisos?.includes('tenant.settings') && <RecordatoriosDeCita />}
    </section>
  );
}
