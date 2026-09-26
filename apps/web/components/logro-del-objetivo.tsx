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
}

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

  const cargar = useCallback(async () => {
    if (!session || !tenant || !agente) return;
    try {
      setTasa(await apiFetch<TasaDto>(config, session, tenant, `/agents/${agente.id}/objetivo`));
    } catch {
      /* sin permiso para ver el consumo del asistente: la sección no aparece */
    }
  }, [config, session, tenant, agente]);
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
              <dd className="text-micro text-muted">{tasa.porElAgente} de {tasa.cerrados}</dd>
            </div>
            <div>
              <dt className="rotulo">Con ayuda del equipo</dt>
              <dd className="dato text-2xl font-bold text-ink">{pct(tasa.tasaConAsistencia ?? 0)}</dd>
              <dd className="text-micro text-muted">
                {tasa.asistidos} {tasa.asistidos === 1 ? 'conversación' : 'conversaciones'} las terminó alguien
              </dd>
            </div>
            <div>
              <dt className="rotulo">No se logró</dt>
              <dd className="dato text-2xl font-bold text-ink">{tasa.perdidos}</dd>
              <dd className="text-micro text-muted">de {tasa.cerrados} terminadas</dd>
            </div>
          </dl>
          <p className="mt-3 max-w-prose text-micro text-muted">
            Las dos tasas juntas son lo que decide: si se parecen, el equipo casi no está
            interviniendo; si la segunda es mucho mayor, el asistente abre camino y alguien cierra.
          </p>
        </>
      )}
    </section>
  );
}
