'use client';

import { useEffect, useRef } from 'react';
import { Bot, X } from 'lucide-react';
import { Badge, Skeleton, nombreVisible } from '@iaxti/ui/react';
import { AvisoDeCarga } from '../aviso-de-carga';
import { useCarga } from '../use-carga';
import type { FichaDealDto } from '../../lib/api';

/**
 * La ficha de una oportunidad, al lado del tablero (#1301).
 *
 * No se podía entrar a una oportunidad: la API no tenía una ruta que devolviera
 * UNA, y el tablero mostraba tarjetas que no llevaban a ningún lado.
 *
 * Panel y no página, porque es lo que el tablero necesita: se mira una tarjeta
 * sin perder de vista en qué etapa estaba ni qué hay en las otras columnas, y
 * cerrar es un gesto. Una página completa obliga a volver para seguir
 * trabajando el embudo.
 *
 * ## Una sola línea de tiempo
 *
 * La historia de etapas y lo que hizo el asistente son dos consultas —una de
 * CRM, otra del libro de auditoría— y se muestran JUNTAS, ordenadas por
 * fecha, con lo del asistente marcado. Separadas en dos listas obligaban a
 * leer las dos y cruzarlas mentalmente para contestar «¿esto lo está
 * manejando la IA?», que es justamente la pregunta.
 */
const FECHA = new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short' });
const FECHA_LARGA = new Intl.DateTimeFormat('es-CL', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const fmtClp = (v: string | number | null): string =>
  v === null || v === '' ? '—' : `$${Math.round(Number(v)).toLocaleString('es-CL')}`;

/** Cuánto lleva en la etapa, en la unidad que alguien usaría al hablar. */
function haceCuanto(desde: string): string {
  const dias = Math.floor((Date.now() - new Date(desde).getTime()) / 86_400_000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 31) return `hace ${dias} días`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? 'hace un mes' : `hace ${meses} meses`;
}

/**
 * Lo que hizo el asistente, dicho en castellano.
 *
 * El libro de auditoría guarda `crm.deal.created`, que es correcto para una
 * auditoría y no para quien abre una ficha. Un nombre sin traducción se
 * muestra tal cual en vez de esconderse: ver un código es feo, y no ver que
 * el asistente hizo algo es peor.
 */
const EN_CASTELLANO: Record<string, string> = {
  'crm.deal.created': 'Abrió esta oportunidad',
  'crm.deal.stage_changed': 'La movió de etapa',
  'crm.deal.updated': 'La actualizó',
  'crm.activity.created': 'Dejó una tarea',
  'calendar.appointment.created': 'Tomó una hora',
  'calendar.appointment.rescheduled': 'Movió la hora',
};

/** Las filas se separan con una línea, no con una tarjeta dentro de otra. */
function Fila({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line px-5 py-4">
      <p className="rotulo">{rotulo}</p>
      <div className="mt-2 text-sm text-body">{children}</div>
    </div>
  );
}

type Paso =
  | { clase: 'etapa'; cuando: string; de: string | null; a: string; tipo: string }
  | { clase: 'asistente'; cuando: string; que: string };

/** Las dos fuentes en una sola línea de tiempo, de lo más nuevo a lo más viejo. */
function lineaDeTiempo(ficha: FichaDealDto): Paso[] {
  const pasos: Paso[] = [
    ...ficha.historia.map(
      (h): Paso => ({
        clase: 'etapa',
        cuando: h.created_at,
        de: h.from_stage_name,
        a: h.to_stage_name,
        tipo: h.to_stage_type,
      }),
    ),
    ...ficha.delAsistente.map(
      (a): Paso => ({
        clase: 'asistente',
        cuando: (a.occurredAt ?? a.occurred_at) as string,
        que: EN_CASTELLANO[a.action] ?? a.action,
      }),
    ),
  ];
  return pasos
    .filter((p) => Boolean(p.cuando))
    .sort((a, b) => new Date(b.cuando).getTime() - new Date(a.cuando).getTime());
}

export function FichaOportunidad({ dealId, onCerrar }: { dealId: string; onCerrar: () => void }) {
  const { carga, reintentar } = useCarga<FichaDealDto>(dealId ? `/deals/${dealId}` : null);
  const cerrarRef = useRef<HTMLButtonElement>(null);

  // Escape cierra, y el foco entra al panel: abrir algo con el teclado y no
  // poder cerrarlo con él deja a alguien atrapado en el tablero.
  useEffect(() => {
    cerrarRef.current?.focus();
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar();
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [onCerrar]);

  /*
   * En celular CUBRE; desde `md` convive con el tablero.
   *
   * A 360 px no caben las dos cosas: el panel se lleva su ancho y las columnas
   * quedan en nada. Así que ahí es `fixed` sobre el tablero —ocupa la pantalla
   * y se cierra con el botón de cerrar o con Escape— y desde 768 px vuelve a
   * ser un hermano en la fila, que es para lo que sirve un panel: no perder
   * de vista en qué etapa estaba la oportunidad.
   */
  const marco =
    'fixed inset-0 z-40 flex h-full flex-col overflow-y-auto border-line bg-raised ' +
    'md:relative md:inset-auto md:z-auto md:w-full md:max-w-[26rem] md:shrink-0 md:border-l';

  const cerrar = (
    <button
      ref={cerrarRef}
      type="button"
      onClick={onCerrar}
      aria-label="Cerrar la oportunidad"
      className="-mr-2 -mt-1 flex size-control shrink-0 items-center justify-center rounded-campo text-muted hover:text-ink"
    >
      <X aria-hidden className="size-4" />
    </button>
  );

  if (carga.estado === 'cargando' || carga.estado === 'nada-que-pedir') {
    return (
      <aside aria-label="Oportunidad" aria-busy className={marco}>
        <div className="flex items-start justify-between gap-3 px-5 py-4">
          <Skeleton className="h-6 w-48" />
          {cerrar}
        </div>
        <Fila rotulo="Etapa">
          <Skeleton className="h-4 w-32" />
        </Fila>
        <Fila rotulo="Qué pasó">
          <Skeleton className="h-16" />
        </Fila>
      </aside>
    );
  }

  if (carga.estado !== 'ok') {
    return (
      <aside aria-label="Oportunidad" className={marco}>
        <div className="flex items-start justify-between gap-3 px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Oportunidad</h2>
          {cerrar}
        </div>
        <div className="px-5 pb-5">
          <AvisoDeCarga
            carga={carga}
            onReintentar={reintentar}
            sinPermiso="Las oportunidades las ve quien tiene acceso al CRM."
          />
        </div>
      </aside>
    );
  }

  const { deal, activities } = carga.dato;
  const pasos = lineaDeTiempo(carga.dato);
  const pendientes = activities.filter((a) => !a.doneAt);
  const hechas = activities.length - pendientes.length;
  const monto =
    deal.currency === 'UF' && deal.value !== null
      ? `UF ${Number(deal.value).toLocaleString('es-CL')}`
      : fmtClp(deal.value_clp);

  return (
    <aside aria-label={`Oportunidad ${deal.title}`} className={marco}>
      <div className="flex items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight text-ink">{deal.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
            <span className="dato text-ink">{monto}</span>
            <span aria-hidden className="text-faint">
              ·
            </span>
            {/* A la ficha del contacto y no a un nombre muerto: desde acá se
                sigue la relación, que es de lo que trata el CRM. */}
            {/* `nombreVisible` y no una cadena armada acá: un contacto de
                WhatsApp llega SIN nombre —el caso normal— y escribir «Sin
                nombre» teniendo el teléfono en el mismo objeto no identifica a
                nadie (#1139). */}
            <a href={`/contactos/${deal.contact_id}`} className="truncate">
              {nombreVisible({ name: deal.contact_name, phone: deal.contact_phone })}
            </a>
          </p>
        </div>
        {cerrar}
      </div>

      <Fila rotulo="Etapa">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{deal.stage_name}</span>
          <span className="text-muted">
            en {deal.pipeline_name} · entró {haceCuanto(deal.stage_entered_at)}
          </span>
        </p>
        {/* Las tres cosas que cambian qué hacer con ella, y solo cuando pasan. */}
        {deal.status === 'won' && deal.won_at && (
          <p className="mt-2">
            <Badge role="good">Ganada</Badge>{' '}
            <span className="dato text-muted">{FECHA_LARGA.format(new Date(deal.won_at))}</span>
          </p>
        )}
        {deal.status === 'lost' && (
          <p className="mt-2">
            <Badge role="bad">Perdida</Badge>{' '}
            <span className="text-muted">{deal.lost_reason ?? 'sin motivo anotado'}</span>
          </p>
        )}
        {deal.status === 'open' && deal.stalled && (
          <p className="mt-2">
            <Badge role="warn">Estancada</Badge>{' '}
            <span className="text-muted">lleva demasiado sin moverse</span>
          </p>
        )}
      </Fila>

      <Fila rotulo="Qué pasó">
        {pasos.length === 0 ? (
          <p className="text-muted">Todavía no se movió de donde nació.</p>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {pasos.map((paso, i) => (
              <li key={`${paso.clase}-${paso.cuando}-${i}`} className="flex items-baseline gap-3">
                <span className="dato shrink-0 text-xs text-muted">
                  {FECHA.format(new Date(paso.cuando))}
                </span>
                {paso.clase === 'asistente' ? (
                  <span className="flex min-w-0 items-baseline gap-1.5 text-action-text">
                    <Bot aria-hidden className="size-3.5 shrink-0 translate-y-0.5" />
                    <span className="min-w-0">{paso.que}</span>
                  </span>
                ) : (
                  <span className="min-w-0 text-ink">
                    {/* Sin etapa de origen la oportunidad no viene de ningún
                        lado: nace. «De la nada a Nuevo» no es un movimiento. */}
                    {paso.de === null ? 'Creada en ' : `De ${paso.de} a `}
                    <span className="font-medium">{paso.a}</span>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </Fila>

      <Fila rotulo="Pendientes">
        {pendientes.length === 0 ? (
          <p className="text-muted">
            {hechas > 0
              ? `Nada pendiente. ${hechas === 1 ? 'Una tarea hecha' : `${hechas} tareas hechas`}.`
              : 'Nada pendiente.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pendientes.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-ink">{a.title}</span>
                {a.dueAt && (
                  <span className="dato shrink-0 text-xs text-muted">
                    {FECHA.format(new Date(a.dueAt))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Fila>
    </aside>
  );
}
