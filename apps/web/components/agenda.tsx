'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, Input, Skeleton, useSession, type BadgeRole,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { RecordatoriosDeCita } from './recordatorios-de-cita';
import { HorariosDeAtencion } from './horarios-de-atencion';
import { DarUnaHora } from './dar-una-hora';
import { PorQueSeCancelan } from './por-que-se-cancelan';
import { apiFetch, type CitaDto } from '../lib/api';

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
  const tenant = selectedTenant();
  const [citas, setCitas] = useState<CitaDto[] | null>(null);
  const [porCancelar, setPorCancelar] = useState<CitaDto | null>(null);
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
      setError((e as Error).message);
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
      setError((e as Error).message);
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

      {error && (
        <AvisoResultado tono="error">
          {error}
        </AvisoResultado>
      )}

      {porDia.size === 0 ? (
        <div className="pulso-panel rounded-tarjeta border border-line bg-raised p-8 text-center">
          <h2 className="text-lg font-bold text-ink">Todavía no hay horas agendadas</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-body">
            Van a aparecer acá cuando alguien tome una hora — desde una conversación de la bandeja
            o cuando tú la agendes.
          </p>
        </div>
      ) : (
        [...porDia.entries()].map(([clave, delDia]) => (
          <div key={clave} className="flex flex-col gap-2">
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
                    {SIGUIENTES[c.status].map((s) => (
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

      <PorQueSeCancelan />
      <DarUnaHora onAgendada={() => void cargar()} />
      <HorariosDeAtencion />
      <RecordatoriosDeCita />
    </section>
  );
}
