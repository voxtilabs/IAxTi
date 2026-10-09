'use client';

import { useCallback, useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { useSession } from '@iaxti/ui/react';
import { SelectorDeAsistente, useAsistenteElegido } from './selector-de-asistente';
import { apiFetch } from '../lib/api';

/**
 * Si el asistente está logrando su objetivo (#460).
 *
 * `GET /agents/:id/objetivo` existe desde #319 y no la llamaba nadie. Cada
 * conversación que el asistente atiende deja un intento con su desenlace y
 * su ATRIBUCIÓN —lo logró él, ayudó, o lo terminó una persona—, y todo eso
 * se medía sin que nadie pudiera verlo.
 *
 * Lo que decide no es el porcentaje: son las dos tasas juntas. «45% él,
 * 72% con ayuda» dice que sirve pero no solo; «70% él, 71% con ayuda» dice
 * que el equipo casi no está interviniendo.
 */
interface TasaDto {
  objetivo: string | null;
  cerrados: number;
  pendientes: number;
  porElAgente: number;
  asistidos: number;
  perdidos: number;
  tasaDelAgente: number | null;
  tasaConAsistencia: number | null;
  /**
   * El respaldo de la tasa (#701).
   *
   * `achieved_event` y `closed_at` se escribían desde #319 y nada las leía: el
   * porcentaje no tenía forma de revisarse, y esta métrica vale exactamente lo
   * que el dueño le crea.
   */
  horasHastaElLogro: number | null;
  porEvento: Array<{ evento: string; n: number }>;
  /** Resultados que llegaron tarde. No suman a ninguna tasa. */
  fueraDeVentana: number;
}

interface IntentosDto {
  logrados: Array<{
    conversationId: string;
    evento: string | null;
    atribucion: 'agente' | 'asistida' | null;
    closedAt: string | null;
    horas: number | null;
  }>;
  fueraDeVentana: Array<{
    conversationId: string;
    evento: string;
    cuando: string;
    diasDespues: number;
    outcome: 'pendiente' | 'logrado' | 'perdido';
  }>;
  ventanaDias: number;
}

/** Los eventos del catálogo, en la voz del negocio y no en la del código. */
const EVENTO_LEGIBLE: Record<string, string> = {
  'appointment.created': 'se agendó una hora',
  'deal.created': 'se abrió una oportunidad',
  'deal.stage_changed': 'la oportunidad avanzó',
  'payment.received': 'se recibió un pago',
  'sin registrar': 'sin registrar',
};
const legible = (evento: string | null): string =>
  evento === null ? 'sin registrar' : (EVENTO_LEGIBLE[evento] ?? evento);

interface AgenteDto {
  id: string;
  name: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function LogroDelObjetivo() {
  const { config, session } = useSession();
  // El objetivo es de CADA asistente: el que vende y el que responde números
  // no se miden con la misma vara, y mostrar la tasa de uno bajo el nombre
  // del otro es peor que no mostrarla (#494).
  const { tenant, asistentes, elegido: agente, elegir } = useAsistenteElegido<AgenteDto>();
  const [tasa, setTasa] = useState<TasaDto | null>(null);
  /** El detalle se pide al abrir: la mayoría mira el porcentaje y se va. */
  const [intentos, setIntentos] = useState<IntentosDto | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant || !agente) return;
    try {
      setTasa(await apiFetch<TasaDto>(config, session, tenant, `/agents/${agente.id}/objetivo`));
      setIntentos(null);
    } catch {
      /* sin permiso para ver el consumo del asistente: la sección no aparece */
    }
  }, [config, session, tenant, agente]);

  const verDetalle = useCallback(
    async (abierto: boolean) => {
      if (!abierto || intentos || !session || !tenant || !agente) return;
      try {
        setIntentos(
          await apiFetch<IntentosDto>(config, session, tenant, `/agents/${agente.id}/objetivo/intentos`),
        );
      } catch {
        /* el porcentaje se sigue viendo: el detalle es un extra */
      }
    },
    [config, session, tenant, agente, intentos],
  );
  useEffect(() => void cargar(), [cargar]);

  if (!tenant || !agente || !tasa || tasa.objetivo === null) return null;

  const total = tasa.cerrados + tasa.pendientes;

  return (
    <section
      aria-label="Logro del objetivo"
      className="mt-6 pulso-panel rounded-tarjeta border border-line bg-raised p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Target aria-hidden className="size-4 text-action-text" />
        <h2 className="font-display text-seccion font-bold text-ink">¿Está logrando lo suyo?</h2>
        <span className="ml-auto">
          <SelectorDeAsistente asistentes={asistentes ?? []} elegidoId={agente.id} onElegir={elegir} />
        </span>
      </div>
      <p className="mt-1 max-w-prose text-dato text-body">
        Cada conversación que atiende {agente.name} deja un intento, y al cerrarse se anota quién lo
        consiguió. Van {total} {total === 1 ? 'conversación' : 'conversaciones'}.
      </p>

      {tasa.cerrados === 0 ? (
        // Sin conversaciones terminadas no hay tasa. Decirlo así evita leer
        // un 0% como "le va pésimo" cuando todavía no se sabe.
        <p className="mt-3 text-sm text-muted">
          Todavía ninguna terminó: {tasa.pendientes} sigue{tasa.pendientes === 1 ? '' : 'n'} abierta
          {tasa.pendientes === 1 ? '' : 's'}. Cuando cierren aparece acá.
        </p>
      ) : (
        <>
          <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
            <div>
              <dt className="rotulo">Lo logró solo</dt>
              <dd className="dato text-2xl font-bold text-ink">{pct(tasa.tasaDelAgente ?? 0)}</dd>
              <dd className="text-rotulo text-muted">{tasa.porElAgente} de {tasa.cerrados}</dd>
            </div>
            <div>
              <dt className="rotulo">Con ayuda del equipo</dt>
              <dd className="dato text-2xl font-bold text-ink">{pct(tasa.tasaConAsistencia ?? 0)}</dd>
              <dd className="text-rotulo text-muted">
                {tasa.asistidos} {tasa.asistidos === 1 ? 'conversación' : 'conversaciones'} las terminó alguien
              </dd>
            </div>
            <div>
              <dt className="rotulo">No se logró</dt>
              <dd className="dato text-2xl font-bold text-ink">{tasa.perdidos}</dd>
              <dd className="text-rotulo text-muted">de {tasa.cerrados} terminadas</dd>
            </div>
          </dl>
          {/* Cuánto tarda, de `closed_at − started_at` y no de una resta
              contra ahora: restar contra ahora da un número que crece solo con
              el tiempo aunque no pase nada (#701). */}
          {tasa.horasHastaElLogro !== null && (
            <p className="mt-3 text-sm text-body">
              Cuando lo logra, tarda{' '}
              <span className="dato font-bold text-ink">
                {tasa.horasHastaElLogro < 1
                  ? 'menos de una hora'
                  : `${tasa.horasHastaElLogro} ${tasa.horasHastaElLogro === 1 ? 'hora' : 'horas'}`}
              </span>{' '}
              en promedio desde que empieza a atender.
            </p>
          )}

          {/* Qué contó como logro: el respaldo de la tasa. */}
          {tasa.porEvento.length > 0 && (
            <p className="mt-2 text-sm text-body">
              Lo que contó como logro:{' '}
              {tasa.porEvento.map((e, i) => (
                <span key={e.evento}>
                  {i > 0 && ', '}
                  {legible(e.evento)} <span className="dato">({e.n})</span>
                </span>
              ))}
              .
            </p>
          )}

          {/* Lo que llegó tarde. No suma a ninguna tasa, y por eso se dice
              aparte: sin el número, «no contó» y «no pasó» se ven idénticos. */}
          {tasa.fueraDeVentana > 0 && (
            <p className="mt-2 text-sm text-muted">
              Hay <span className="dato">{tasa.fueraDeVentana}</span>{' '}
              {tasa.fueraDeVentana === 1 ? 'resultado que llegó' : 'resultados que llegaron'} después
              de la ventana que atribuimos, así que no{' '}
              {tasa.fueraDeVentana === 1 ? 'cuenta' : 'cuentan'} en estas tasas.
            </p>
          )}

          <details className="mt-3" onToggle={(e) => void verDetalle((e.currentTarget as HTMLDetailsElement).open)}>
            <summary className="w-fit cursor-pointer text-sm text-action-text">Ver caso por caso</summary>
            {!intentos ? (
              <p className="mt-2 text-xs text-muted">Cargando…</p>
            ) : (
              <>
                {intentos.logrados.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1">
                    {intentos.logrados.map((l) => (
                      <li key={l.conversationId} className="text-xs text-body">
                        <span className="dato text-muted">
                          {l.closedAt ? new Date(l.closedAt).toLocaleDateString('es-CL') : '—'}
                        </span>{' '}
                        {legible(l.evento)}
                        {l.horas !== null && <span className="text-muted"> · en {l.horas} h</span>}
                        <span className="text-muted">
                          {' '}· {l.atribucion === 'agente' ? 'lo hizo el asistente' : 'lo cerró alguien del equipo'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {intentos.fueraDeVentana.length > 0 && (
                  <>
                    <p className="mt-3 rotulo">Llegaron tarde</p>
                    <ul className="mt-1 flex flex-col gap-1">
                      {intentos.fueraDeVentana.map((f) => (
                        <li key={f.conversationId} className="text-xs text-muted">
                          {legible(f.evento)}, <span className="dato">{f.diasDespues}</span> días después de
                          abrirse el intento — la ventana es de{' '}
                          <span className="dato">{intentos.ventanaDias}</span>, así que no contó.
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {intentos.logrados.length === 0 && intentos.fueraDeVentana.length === 0 && (
                  <p className="mt-2 text-xs text-muted">Todavía no hay casos que mostrar.</p>
                )}
              </>
            )}
          </details>

          <p className="mt-3 max-w-prose text-rotulo text-muted">
            Las dos tasas juntas son lo que decide: si se parecen, el equipo casi no está
            interviniendo; si la segunda es mucho mayor, el asistente abre camino y alguien cierra.
          </p>
        </>
      )}
    </section>
  );
}
