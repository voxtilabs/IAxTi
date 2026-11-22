'use client';

import { AvisoResultado, EncabezadoDePagina, Seccion } from '@iaxti/ui/react';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, Input, Skeleton, Tabs, TabsList, TabsTrigger, useSession, type BadgeRole,
} from '@iaxti/ui/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSelectedTenant } from './tenant-switcher';
import { useArranque } from './arranque';
import { GoogleCalendarConnection } from './google-calendar';
import { RecordatoriosDeCita } from './recordatorios-de-cita';
import { HorariosDeAtencion } from './horarios-de-atencion';
import { DiasCerrados } from './dias-cerrados';
import { DarUnaHora } from './dar-una-hora';
import { PorQueSeCancelan } from './por-que-se-cancelan';
import { apiFetch, avisoDe, type CitaDto } from '../lib/api';

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

/**
 * El día LOCAL de la cita como clave `YYYY-MM-DD`.
 *
 * La lista agrupaba con `startsAt.slice(0, 10)`, que es el día UTC, mientras
 * el encabezado la formateaba en hora local: en Chile una cita de las
 * 22:00 caía en el grupo del día siguiente y la lista la mostraba bajo el
 * título de otro día. El horario de silencio (21:00) la escondía casi
 * siempre; el calendario del mes completo la habría destapado en cada punta
 * de rango. Una sola clave local para la lista y la grilla.
 */
function claveDia(iso: string): string {
  const d = new Date(iso);
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

/** Cómo se pinta la píldora de una cita dentro del día, por el rol de su
    estado: fondo soft y texto del rol, igual que las etiquetas (Mesón). */
const PILSITA: Record<BadgeRole, string> = {
  action: 'bg-action-soft text-action-text',
  info: 'bg-action-soft text-action-text',
  good: 'bg-good-soft text-good-text',
  warn: 'bg-warn-soft text-warn-text',
  bad: 'bg-bad-soft text-bad-text',
  neutral: 'bg-rest text-muted',
};

/**
 * La grilla del mes: desde la primera celda (el lunes de la semana que
 * contiene el día 1 — es-CL empieza la semana el lunes) hasta la última (el
 * domingo de la semana que contiene el fin de mes), en filas completas de 7.
 * Las dos puntas son a la vez lo que la grilla pinta y lo que la API pide:
 * pedido y mostrado no pueden descuar porque salen del mismo cálculo.
 */
function grillaDe(ancla: Date): { inicio: Date; fin: Date; celdas: Date[] } {
  const y = ancla.getFullYear();
  const m = ancla.getMonth();
  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // lunes primero
  const diasMes = new Date(y, m + 1, 0).getDate();
  const filas = Math.ceil((offset + diasMes) / 7);
  const inicio = new Date(y, m, 1 - offset);
  const celdas = Array.from({ length: filas * 7 }, (_, i) => new Date(y, m, 1 - offset + i));
  // El fin EXCLUYENTE (la medianoche después de la última celda): la API
  // recibe desde/hasta y la celda final queda adentro, no en el borde.
  const fin = new Date(y, m, 1 - offset + filas * 7);
  return { inicio, fin, celdas };
}

/**
 * La fila de una cita, la misma en la lista y en el día elegido del
 * calendario (#1368): las acciones que se ven desde la grilla son las
 * mismas que desde la lista porque son EL MISMO componente. Si el dominio
 * prohíbe algo, el botón no está — y está igual en los dos lados.
 */
function FilaCita({
  cita, moviendo, puedeAgendar, onCambiar, onCancelar, onMover,
}: {
  cita: CitaDto;
  moviendo: string | null;
  puedeAgendar: boolean;
  onCambiar: (cita: CitaDto, a: CitaDto['status']) => void;
  onCancelar: (cita: CitaDto) => void;
  onMover: (cita: CitaDto) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 pulso-panel rounded-tarjeta border border-line bg-raised px-4 py-3">
      <span className="dato text-base text-ink">
        {hora(cita.startsAt)}–{hora(cita.endsAt)}
      </span>
      <a
        href={`/contactos/${cita.contactId}`}
        className="min-w-0 flex-1 truncate text-sm text-action-text"
      >
        {cita.title ?? 'Sin título'}
      </a>
      <Badge role={ETIQUETA[cita.status].rol}>{ETIQUETA[cita.status].texto}</Badge>
      {/* Por qué se cayó (#700): se escribía y no se mostraba. */}
      {cita.status === 'cancelled' && cita.cancelReason && (
        <span className="w-full text-xs text-muted sm:w-auto">{cita.cancelReason}</span>
      )}
      {/* Cancelada acá y viva en Google: ocupa una hora que el
          vendedor ve libre, así que se dice en la cita. */}
      {cita.googleSyncError && (
        <span className="w-full text-xs text-warn-text">{cita.googleSyncError}</span>
      )}
      {/* El recordatorio que no salió (#1250). Sin esto la fila
          decía «Avisada» sobre alguien a quien no le llegó nada:
          el dueño no puede arreglar lo que no ve. */}
      {cita.avisoError && (
        <span className="w-full text-xs text-warn-text">{cita.avisoError}</span>
      )}
      <span className="flex flex-wrap gap-2">
        {puedeAgendar && SIGUIENTES[cita.status].map((s) => (
          <Button
            key={s.a}
            variant={s.a === 'cancelled' ? 'fantasma' : 'secundario'}
            size="chico"
            disabled={moviendo === cita.id}
            onClick={() =>
              s.a === 'cancelled'
                ? onCancelar(cita)
                : onCambiar(cita, s.a)
            }
          >
            {s.texto}
          </Button>
        ))}
        {/* Mover solo donde se puede: una cita cancelada o que ya
            pasó no se mueve, se agenda otra (#836). El botón no
            aparece en vez de aparecer y fallar. */}
        {SE_PUEDE_MOVER.has(cita.status) && (
          <Button
            variant="fantasma"
            size="chico"
            disabled={moviendo === cita.id}
            onClick={() => onMover(cita)}
          >
            Mover
          </Button>
        )}
      </span>
    </li>
  );
}

export function Agenda() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const { arranque } = useArranque();
  const puedeAgendar = Boolean(arranque?.permisos?.includes('calendar.book'));
  const [citas, setCitas] = useState<CitaDto[] | null>(null);
  /* El calendario (#1368): la vista, el mes que se mira, sus citas y el
     día elegido. La lista sigue siendo el default: es lo que ya existía. */
  const [vista, setVista] = useState<'lista' | 'calendario'>('lista');
  const [mesAncla, setMesAncla] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [citasMes, setCitasMes] = useState<CitaDto[] | null>(null);
  const [diaElegido, setDiaElegido] = useState<string | null>(null);
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
      setError(avisoDe(e).texto);
      setCitas([]);
    }
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /**
   * Las citas del mes que se mira (#1368).
   *
   * La API ya servía por rango (`cargar` pide desde/hasta): pedir el mes
   * visible no es un endpoint nuevo. El rango va de la PRIMERA celda de la
   * grilla a la última —las semanas que se asoman del mes vecino también
   * tienen citas—, y la grilla calcula las dos puntas con la misma aritmética
   * que la pinta, así que lo pedido y lo mostrado no pueden descuar.
   */
  const cargarMes = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const ancla = mesAncla;
      const semanas = grillaDe(ancla);
      const r = await apiFetch<CitaDto[]>(
        config,
        session,
        tenant,
        `/agenda?desde=${semanas.inicio.toISOString()}&hasta=${semanas.fin.toISOString()}`,
      );
      setCitasMes(r);
      setError(null);
    } catch (e) {
      setError(avisoDe(e).texto);
      setCitasMes([]);
    }
  }, [config, session, tenant, mesAncla]);

  useEffect(() => {
    if (vista === 'calendario') void cargarMes();
  }, [vista, cargarMes]);

  // Las citas del mes visible, agrupadas por su clave de día local: las
  // celdas de la grilla miran este mapa.
  const porDiaMes = useMemo(() => {
    const mapa = new Map<string, CitaDto[]>();
    for (const c of [...(citasMes ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const clave = claveDia(c.startsAt);
      mapa.set(clave, [...(mapa.get(clave) ?? []), c]);
    }
    return mapa;
  }, [citasMes]);

  async function cambiar(cita: CitaDto, a: CitaDto['status'], motivo?: string) {
    if (!session || !tenant || moviendo) return;
    setMoviendo(cita.id);
    try {
      await apiFetch(config, session, tenant, `/agenda/${cita.id}/estado`, {
        method: 'POST',
        body: JSON.stringify(motivo ? { estado: a, motivo } : { estado: a }),
      });
      await cargar();
      // El calendario también tiene la cita: si no, el día elegido enseña
      // el estado viejo hasta que alguien navegue de mes y vuelva.
      if (vista === 'calendario') await cargarMes();
    } catch (e) {
      setError(avisoDe(e).texto);
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
      if (vista === 'calendario') await cargarMes();
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
    const clave = claveDia(c.startsAt);
    porDia.set(clave, [...(porDia.get(clave) ?? []), c]);
  }

  /**
   * Preparar «Mover» desde cualquier fila (la lista o el calendario).
   *
   * Se conserva el LARGO de la cita y el campo arranca en la hora actual de
   * la cita, en local: mover es corregir, no escribir de cero (#836).
   */
  function prepararMover(cita: CitaDto) {
    const d = new Date(cita.startsAt);
    const dos = (n: number) => String(n).padStart(2, '0');
    setNuevaHora(
      `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}`,
    );
    setPorMover(cita);
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <EncabezadoDePagina
          titulo="Agenda"
          apoyo={vista === 'calendario' ? 'El mes de un vistazo.' : 'Las próximas dos semanas.'}
          className="mb-0"
        />
        <Tabs value={vista} onValueChange={(v) => setVista(v as typeof vista)} className="ml-auto">
          <TabsList>
            <TabsTrigger value="lista">Lista</TabsTrigger>
            <TabsTrigger value="calendario">Calendario</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <GoogleCalendarConnection />

      {error && (
        <AvisoResultado tono="error">
          {error}
        </AvisoResultado>
      )}

      {vista === 'lista' && (porDia.size === 0 ? (
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
                <FilaCita
                  key={c.id}
                  cita={c}
                  moviendo={moviendo}
                  puedeAgendar={puedeAgendar}
                  onCambiar={(cita, a) => void cambiar(cita, a)}
                  onCancelar={(cita) => {
                    setPorCancelar(cita);
                    setMotivo('');
                  }}
                  onMover={prepararMover}
                />
              ))}
            </ul>
          </div>
        ))
      ))}
      {/* El calendario (#1368): el mes de un vistazo, para ver huecos y
          semanas sin leer una lista. Cada día ES el control: se toca y sus
          citas aparecen debajo con las mismas filas de la lista — las
          acciones son las mismas porque son el mismo componente. */}
      {vista === 'calendario' && (
        <div className="flex w-full max-w-seccion flex-col gap-3">
          {/* `min-w-0` en el título y `flex-wrap` en la fila: a 360 px el
              título («noviembre de 2026») empuja el botón «Hoy» fuera de la
              ventana — 2 botones + título + Hoy + gaps + el margen del shell
              no caben en una línea. El título cede (es texto) y Hoy baja
              solo si hace falta. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secundario"
              size="chico"
              aria-label="Mes anterior"
              onClick={() => setMesAncla(new Date(mesAncla.getFullYear(), mesAncla.getMonth() - 1, 1))}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <h2 className="min-w-0 flex-1 text-center text-sm font-semibold capitalize text-ink">
              {mesAncla.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' })}
            </h2>
            <Button
              variant="secundario"
              size="chico"
              aria-label="Mes siguiente"
              onClick={() => setMesAncla(new Date(mesAncla.getFullYear(), mesAncla.getMonth() + 1, 1))}
            >
              <ChevronRight aria-hidden />
            </Button>
            <Button
              variant="fantasma"
              size="chico"
              className="ml-auto"
              onClick={() => {
                const d = new Date();
                setMesAncla(new Date(d.getFullYear(), d.getMonth(), 1));
              }}
            >
              Hoy
            </Button>
          </div>
          {citasMes === null ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="pulso-panel rounded-tarjeta border border-line bg-raised p-2">
                <div aria-hidden className="grid grid-cols-7 gap-px pb-1">
                  {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => (
                    <span key={d} className="text-center text-[11px] font-medium text-muted">
                      {d}
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-px">
                  {grillaDe(mesAncla).celdas.map((d) => {
                    const clave = claveDia(d.toISOString());
                    const enMes = d.getMonth() === mesAncla.getMonth();
                    const delDia = porDiaMes.get(clave) ?? [];
                    const esHoy = clave === claveDia(new Date().toISOString());
                    const fecha = d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long' });
                    const nombre = delDia.length
                      ? `${fecha}, ${delDia.length === 1 ? '1 hora' : `${delDia.length} horas`}`
                      : `${fecha}, sin horas`;
                    const estado = diaElegido === clave
                      ? 'bg-rest'
                      : delDia.length
                        ? 'hover:bg-rest'
                        : '';
                    const numero = esHoy
                      ? 'font-semibold text-action-text'
                      : delDia.length
                        ? 'font-medium text-ink'
                        : 'text-muted';
                    const celda = `flex min-h-16 flex-col items-center gap-0.5 rounded-campo p-1 text-center text-xs${enMes || delDia.length ? '' : ' opacity-40'}`;
                    const contenido = (
                      <>
                        <span className={numero}>{d.getDate()}</span>
                        {delDia.slice(0, 2).map((c) => (
                          <span
                            key={c.id}
                            className={`w-full truncate rounded px-1 text-[10px] leading-4 ${PILSITA[ETIQUETA[c.status].rol]}`}
                          >
                            {hora(c.startsAt)}
                          </span>
                        ))}
                        {delDia.length > 2 && (
                          <span className="text-[10px] text-muted">+{delDia.length - 2}</span>
                        )}
                      </>
                    );
                    // Todo día del mes es elegible, con o sin citas: sin
                    // ellas, la grilla dice «sin horas» — mirar si hay hueco
                    // también es trabajo de agenda. El mes vecino solo es
                    // botón si se asoma con algo.
                    return enMes || delDia.length ? (
                      <button
                        key={clave}
                        type="button"
                        aria-label={nombre}
                        aria-current={esHoy ? 'date' : undefined}
                        onClick={() => setDiaElegido(clave)}
                        className={`cursor-pointer ${celda} ${estado}`}
                      >
                        {contenido}
                      </button>
                    ) : (
                      <div
                        key={clave}
                        aria-current={esHoy ? 'date' : undefined}
                        className={celda}
                      >
                        {contenido}
                      </div>
                    );
                  })}
                </div>
              </div>
              {diaElegido && (
                <div className="flex flex-col gap-2">
                  {(porDiaMes.get(diaElegido) ?? []).length ? (
                    (() => {
                      const delDia = porDiaMes.get(diaElegido)!;
                      return (
                        <>
                          <h3 className="text-sm font-medium capitalize text-muted">
                            {dia(delDia[0].startsAt)}
                          </h3>
                          <ul className="flex flex-col gap-2">
                            {delDia.map((c) => (
                              <FilaCita
                                key={c.id}
                                cita={c}
                                moviendo={moviendo}
                                puedeAgendar={puedeAgendar}
                                onCambiar={(cita, a) => void cambiar(cita, a)}
                                onCancelar={(cita) => {
                                  setPorCancelar(cita);
                                  setMotivo('');
                                }}
                                onMover={prepararMover}
                              />
                            ))}
                          </ul>
                        </>
                      );
                    })()
                  ) : (
                    <p className="text-sm text-muted">Ese día no tiene horas agendadas.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
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
      {/* Debajo del horario y no arriba: primero se dice cuándo se atiende, y
          después las excepciones a eso (#1281). */}
      {arranque?.permisos?.includes('calendar.manage_availability') && <DiasCerrados />}
      {arranque?.permisos?.includes('tenant.settings') && <RecordatoriosDeCita />}
    </section>
  );
}
