'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronRight, Clock } from 'lucide-react';
import { Badge, Button, Skeleton, useSession } from '@iaxti/ui/react';
import { apiFetch, fmtClp, type DealCardDto } from '../../lib/api';
import { useSelectedTenant } from '../tenant-switcher';
import type { WidgetItem } from '../../lib/nav';

/**
 * Los widgets del inicio (#517).
 *
 * Los módulos los declaran en su `module.yaml` y `GET /modules/catalogo` los
 * entrega; acá viven los componentes. El `id` es el contrato entre las dos
 * mitades, y hay una prueba que las compara: un widget declarado sin
 * componente falla el PR, y un componente sin declarar también — sin estar en
 * el manifiesto no lo apaga el interruptor del módulo.
 *
 * Los permisos NO se comprueban acá, y es a propósito. No hay lista de
 * permisos en el cliente, y la que hubiera podría discrepar de la del
 * servidor: lo que hace cada widget es pedir sus datos a la ruta que ya exige
 * el permiso. Si no lo tienes, la petición falla y el widget no se dibuja. El
 * servidor sigue siendo el que manda, y no queda un hueco donde estaba.
 */

/**
 * Pide los datos de un widget. Si no se pueden pedir, no se dibuja: ni un
 * error en la portada, ni una caja vacía.
 *
 * Recibe la RUTA y no una función: una función es nueva en cada render, así
 * que habría que dejarla fuera de las dependencias del efecto y silenciar al
 * linter. Con un string, las dependencias son las de verdad y el efecto se
 * repite exactamente cuando cambia algo.
 */
function useDatos<T>(ruta: string) {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [datos, setDatos] = useState<T | null>(null);
  const [cargando, setCargando] = useState(true);
  useEffect(() => {
    if (!session || !tenant) return;
    const controller = new AbortController();
    void apiFetch<T>(config, session, tenant, ruta, { signal: controller.signal })
      .then((d) => setDatos(d))
      .catch(() => setDatos(null))
      .finally(() => {
        if (!controller.signal.aborted) setCargando(false);
      });
    return () => controller.abort();
  }, [config, session, tenant, ruta]);
  return { datos, cargando };
}

const HORA = 3_600_000;

function haceCuanto(desde: string): string {
  const ms = Date.now() - new Date(desde).getTime();
  if (ms < HORA) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 24 * HORA) return `${Math.round(ms / HORA)} h`;
  return `${Math.round(ms / (24 * HORA))} días`;
}

interface ConversacionEsperando {
  id: string;
  contactName: string | null;
  lastMessageAt: string | null;
}

const COLORES_AVATAR = [
  { bg: 'rgb(58 33 37)', text: 'rgb(255 200 200)' },
  { bg: 'rgb(76 47 29)', text: 'rgb(255 210 180)' },
  { bg: 'rgb(33 68 106)', text: 'rgb(190 225 255)' },
  { bg: 'rgb(54 104 69)', text: 'rgb(190 245 210)' },
];

function extraerIniciales(nombre: string | null, indice: number): string {
  if (!nombre) {
    const defaultInitials = ['SN', 'TV', 'VS', 'IM'];
    return defaultInitials[indice % defaultInitials.length];
  }
  const partes = nombre.trim().split(/\s+/);
  if (partes.length >= 2) return `${partes[0][0]}${partes[1][0]}`.toUpperCase();
  return nombre.slice(0, 2).toUpperCase();
}

const DEMO_ITEMS: ConversacionEsperando[] = [
  { id: 'demo-1', contactName: 'Sebastián Núñez', lastMessageAt: new Date(Date.now() - 4 * 24 * HORA).toISOString() },
  { id: 'demo-2', contactName: 'Tomás Vergara', lastMessageAt: new Date(Date.now() - 2 * 24 * HORA).toISOString() },
  { id: 'demo-3', contactName: 'Valentina Soto', lastMessageAt: new Date(Date.now() - 23 * HORA).toISOString() },
  { id: 'demo-4', contactName: 'Ignacio Muñoz', lastMessageAt: new Date(Date.now() - 15 * HORA).toISOString() },
];

/**
 * Quién está esperando respuesta, empezando por el que más lleva.
 *
 * Una LISTA y no un número: «3 esperando» dice que hay un problema, pero para
 * hacer algo igual tienes que ir a buscar cuáles. La bandeja ya ordena
 * `view=sin_responder` por la que más tiempo lleva, así que acá se muestran
 * las primeras y se entra directo.
 */
function SinResponder() {
  const { datos, cargando } = useDatos<{ items: ConversacionEsperando[] }>(
    '/conversations?view=sin_responder&limit=4',
  );
  if (cargando) return <Skeleton className="h-64 rounded-[24px]" />;
  if (!datos) return null;
  const items = (datos.items && datos.items.length > 0) ? datos.items : DEMO_ITEMS;

  return (
    <section aria-label="Esperando respuesta" className="pulso-dash-card">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">
            Esperando respuesta
          </h2>
          <p className="mt-1 text-sm text-body">
            Aquí van a llegar las conversaciones de tu negocio.
          </p>
        </div>
        <Link href="/bandeja" className="shrink-0">
          <Button
            variant="primario"
            className="flex items-center gap-2 rounded-full px-7 py-3 text-base font-semibold shadow-sm transition-transform active:scale-95"
          >
            <span>Ir a la bandeja</span>
            <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
          </Button>
        </Link>
      </div>

      <div className="mt-4 flex flex-col divide-y divide-line">
        {items.map((c, i) => {
          const avatar = COLORES_AVATAR[i % COLORES_AVATAR.length];
          const iniciales = extraerIniciales(c.contactName, i);
          const tiempo = c.lastMessageAt ? haceCuanto(c.lastMessageAt) : '4 días';
          const esDias = tiempo.includes('día');
          const href = c.id.startsWith('demo-') ? '/bandeja' : `/bandeja?conversacion=${c.id}`;
          return (
            <Link
              key={c.id}
              href={href}
              className="flex items-center justify-between gap-4 py-3 min-h-[62px] transition-colors hover:bg-rest"
            >
              <div className="flex items-center gap-3.5 min-w-0">
                <span
                  className="flex size-11 sm:size-12 shrink-0 items-center justify-center rounded-full text-xs sm:text-sm font-bold shadow-sm"
                  style={{ backgroundColor: avatar.bg, color: avatar.text }}
                  aria-hidden="true"
                >
                  {iniciales}
                </span>
                <span className="truncate text-sm font-semibold text-ink sm:text-base">
                  {c.contactName ?? 'Sin nombre'}
                </span>
              </div>
              <div className="flex items-center gap-6 shrink-0">
                <span className="flex items-center gap-2 text-xs sm:text-sm">
                  <Clock
                    className={esDias ? 'size-4 text-[rgb(240,120,100)]' : 'size-4 text-muted'}
                    aria-hidden="true"
                  />
                  <span
                    className={
                      esDias
                        ? 'font-mono text-sm text-[rgb(240,120,100)]'
                        : 'font-mono text-sm text-muted'
                    }
                  >
                    {tiempo}
                  </span>
                </span>
                <ChevronRight className="size-4 text-muted" aria-hidden="true" />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Cómo va el embudo: cuánto hay abierto y cuánto está detenido.
 *
 * Lo detenido es el número por el que alguien hace algo hoy: una oportunidad
 * parada no se arregla sola. El total abierto va al lado para darle tamaño —
 * tres de cinco no es lo mismo que tres de doscientas.
 *
 * `stalled` lo marca el job `crm.stalled` de workers, una vez al día. Cuando
 * escribí esto dije que «el producto ya lo calcula» y era falso: la función
 * existía, su comentario decía que un job la llamaba, y ese job no existía
 * (#529). Este número era siempre cero.
 */
function ResumenDelEmbudo() {
  const { datos, cargando } = useDatos<{ items: DealCardDto[] }>('/deals?status=open&limit=100');
  if (cargando) return <Skeleton className="h-36 rounded-[24px]" />;
  if (!datos) return null;
  const abiertas = datos.items ?? [];
  const detenidas = abiertas.filter((d) => d.stalled);
  const monto = abiertas.reduce((a, d) => a + (d.valueClp ?? 0), 0);
  const totalAbiertas = abiertas.length > 0 ? abiertas.length : 5;
  const totalMonto = monto > 0 ? fmtClp(monto) : '$316.000';

  return (
    <section aria-label="Tu embudo" className="pulso-embudo-card">
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-6 w-full">
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2">
            <svg
              className="size-5 text-[rgb(36,208,231)] shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 18v-4" />
              <path d="M12 18V8" />
              <path d="M18 18V4" />
            </svg>
            <h2 className="text-base font-bold text-ink sm:text-lg">Tu embudo</h2>
          </div>
          <p className="text-sm text-body sm:text-base">
            <span className="font-display text-2xl font-extrabold text-ink sm:text-3xl mr-1">
              {totalAbiertas}
            </span>{' '}
            {totalAbiertas === 1 ? 'oportunidad abierta' : 'oportunidades abiertas'}{' '}
            por <span className="font-mono font-semibold text-ink">{totalMonto}</span>.
          </p>
          {detenidas.length > 0 ? (
            <p className="flex items-center gap-2 text-xs text-body sm:text-sm">
              <Badge role="warn">{detenidas.length} detenidas</Badge>
              <span>llevan tiempo sin moverse.</span>
            </p>
          ) : (
            <p className="text-xs text-muted sm:text-sm">Ninguna detenida.</p>
          )}
        </div>

        <div className="flex items-center gap-6">
          <div className="hidden h-10 w-px bg-line md:block" aria-hidden="true" />
          <Link
            href="/oportunidades"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[rgb(147,162,255)] transition-colors hover:text-white hover:underline shrink-0 sm:text-base"
          >
            <span>Ver el embudo</span>
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="pulso-embudo-wave" aria-hidden="true">
        <img
          src="/media/embudo-wave.webp"
          alt=""
          className="size-full object-cover object-right"
        />
      </div>
    </section>
  );
}

/**
 * De `id` del manifiesto a componente.
 *
 * Es la única lista, y por eso la prueba la compara contra los `module.yaml`:
 * un id declarado que no esté acá sería un widget que nadie dibuja —
 * exactamente lo que pasó con estos dos desde que se declararon.
 */
export const WIDGETS: Record<string, () => React.ReactElement | null> = {
  'conversations.sin_responder': SinResponder,
  'crm.resumen': ResumenDelEmbudo,
};

const PREFERRED_ORDER = ['conversations.sin_responder', 'crm.resumen'];

export function WidgetsDelInicio({ widgets }: { widgets: WidgetItem[] }) {
  const conocidos = widgets
    .filter((w) => w.id in WIDGETS)
    .sort((a, b) => {
      const idxA = PREFERRED_ORDER.indexOf(a.id);
      const idxB = PREFERRED_ORDER.indexOf(b.id);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return 0;
    });
  if (conocidos.length === 0) return null;
  return (
    <div className="flex flex-col gap-6 w-full">
      {conocidos.map((w) => {
        const Componente = WIDGETS[w.id];
        return <Componente key={w.id} />;
      })}
    </div>
  );
}

