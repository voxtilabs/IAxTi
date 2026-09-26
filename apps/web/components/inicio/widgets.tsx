'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Skeleton, useSession } from '@iaxti/ui/react';
import { apiFetch, fmtClp, type DealCardDto } from '../../lib/api';
import { useSelectedTenant } from '../tenant-switcher';
import type { WidgetItem } from '../../lib/nav';

/**
 * Los widgets del inicio (#517).
 *
 * Los módulos los declaran en su `module.yaml` y `GET /me/modules` los
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

function Tarjeta({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={titulo}
      className="pulso-panel flex flex-col gap-3 rounded-tarjeta border border-line bg-raised p-5"
    >
      <span className="rotulo">{titulo}</span>
      {children}
    </section>
  );
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
  if (cargando) return <Skeleton className="h-32" />;
  if (!datos) return null;
  const items = datos.items ?? [];
  return (
    <Tarjeta titulo="Esperando respuesta">
      {items.length === 0 ? (
        <p className="text-sm text-body">Nadie esperando. Al día.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((c) => (
            <li key={c.id}>
              <Link
                href={`/bandeja?conversacion=${c.id}`}
                className="flex items-center justify-between gap-3 rounded-campo border border-line px-3 py-2 hover:bg-rest"
              >
                <span className="min-w-0 truncate text-sm text-ink">
                  {c.contactName ?? 'Sin nombre'}
                </span>
                {c.lastMessageAt && (
                  <span className="dato shrink-0 text-rotulo text-muted">
                    {haceCuanto(c.lastMessageAt)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href="/bandeja?view=sin_responder" className="text-sm text-action-text">
        Ver la bandeja
      </Link>
    </Tarjeta>
  );
}

/**
 * Cómo va el embudo: cuánto hay abierto y cuánto está detenido.
 *
 * Lo detenido es el número por el que alguien hace algo hoy — una
 * oportunidad parada no se arregla sola, y `stalled` ya lo calcula el
 * producto. El total abierto va al lado para que el detenido tenga tamaño:
 * tres de cinco no es lo mismo que tres de doscientas.
 */
function ResumenDelEmbudo() {
  const { datos, cargando } = useDatos<{ items: DealCardDto[] }>('/deals?status=open&limit=100');
  if (cargando) return <Skeleton className="h-32" />;
  if (!datos) return null;
  const abiertas = datos.items ?? [];
  const detenidas = abiertas.filter((d) => d.stalled);
  const monto = abiertas.reduce((a, d) => a + (d.valueClp ?? 0), 0);
  return (
    <Tarjeta titulo="Tu embudo">
      <p className="text-sm text-body">
        <span className="font-display text-titulo text-ink">{abiertas.length}</span>{' '}
        {abiertas.length === 1 ? 'oportunidad abierta' : 'oportunidades abiertas'}
        {monto > 0 && <> por {fmtClp(monto)}</>}.
      </p>
      {detenidas.length > 0 ? (
        <p className="flex items-center gap-2 text-sm text-body">
          <Badge role="warn">{detenidas.length} detenidas</Badge>
          <span>llevan tiempo sin moverse.</span>
        </p>
      ) : (
        <p className="text-sm text-body">Ninguna detenida.</p>
      )}
      <Link href="/oportunidades" className="text-sm text-action-text">
        Ver el embudo
      </Link>
    </Tarjeta>
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

export function WidgetsDelInicio({ widgets }: { widgets: WidgetItem[] }) {
  const conocidos = widgets.filter((w) => w.id in WIDGETS);
  if (conocidos.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {conocidos.map((w) => {
        const Componente = WIDGETS[w.id];
        return <Componente key={w.id} />;
      })}
    </div>
  );
}
