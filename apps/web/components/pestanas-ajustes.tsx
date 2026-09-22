'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import type { NavItem } from '../lib/nav';

/**
 * Las pestañas de la sección de ajustes en la que estás (#387).
 *
 * Eran dieciséis páginas sueltas: se entraba a una y no había forma de
 * saber qué más había cerca. Ahora cada pantalla muestra arriba las de su
 * misma sección, que es lo que Lino pidió — "la API en un solo lado, la IA
 * en un solo lado".
 *
 * Salen de `GET /me/modules`, igual que el menú. Acá no hay lista: si un
 * módulo se apaga para el tenant, su pestaña desaparece sola.
 */
export function PestanasAjustes({ items, candados }: { items: NavItem[]; candados: Set<string> }) {
  const activa = usePathname();

  const aqui = items.find((i) => i.path === activa);
  const seccion = aqui?.seccion;
  // Sin sección no se dibuja nada: una barra de pestañas con una sola
  // pestaña es ruido con forma de navegación.
  if (!seccion) return null;
  const hermanas = items.filter((i) => i.seccion === seccion);
  if (hermanas.length < 2) return null;

  return (
    // El nombre de la sección NO se repite acá: ya lo dicen la barra lateral
    // (la sección activa) y el rótulo de la propia pantalla. Puesto también
    // en las pestañas, "CANALES" salía dos veces seguidas.
    <nav aria-label={`Ajustes de ${seccion}`} className="mb-6 border-b border-line">
      <ul className="-mb-px flex flex-wrap gap-1">
        {hermanas.map((i) => {
          const puesta = i.path === activa;
          const conCandado = candados.has(i.path);
          return (
            <li key={i.path}>
              <Link
                href={i.path}
                prefetch={false}
                aria-current={puesta ? 'page' : undefined}
                title={conCandado ? 'Tu plan no incluye esta función: puedes mirar, no cambiar.' : undefined}
                className={[
                  'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
                  puesta
                    ? 'border-action font-medium text-action-text'
                    : 'border-transparent text-body hover:text-ink',
                ].join(' ')}
              >
                {i.label}
                {/* El candado se ve: bajar de plan nunca esconde (SPEC §6). */}
                {conCandado && <Lock className="size-3 text-muted" aria-label="incluido en un plan superior" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
