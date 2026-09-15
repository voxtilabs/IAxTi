'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ModeToggle, RequireSession, SessionProvider, useSession, type PublicConfig } from '@iaxti/ui/react';
import { SoporteAviso } from './soporte-aviso';
import { TenantSwitcher } from './tenant-switcher';
import { Campana } from './campana';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

export interface NavItem {
  label: string;
  path: string;
  permission: string;
}

interface ShellProps {
  config: PublicConfig;
  marcaSvg: string;
  nav: NavItem[];
  /** Pantallas a ancho completo (la bandeja): sin contenedor ni padding. */
  sinMargen?: boolean;
  children: ReactNode;
}

/**
 * El menú dice la verdad sobre el plan (issue 215).
 *
 * `GET /me/modules` lo pide la página desde el SERVIDOR, sin sesión y sin
 * tenant: sirve para dibujar el menú, no sabe qué paga este negocio. Acá,
 * que ya hay sesión, se pregunta de nuevo con `modules/plan` y los módulos
 * fuera del plan quedan con candado.
 *
 * No se esconden: §6 es explícito en que bajar de plan deja el módulo en
 * solo lectura, no lo borra. Y mostrar lo que se estaría comprando vale más
 * que ocultarlo.
 */
function useAccesoPorPlan(): Record<string, 'completo' | 'solo_lectura'> {
  const { session, config } = useSession();
  const [acceso, setAcceso] = useState<Record<string, 'completo' | 'solo_lectura'>>({});
  useEffect(() => {
    const tenant = selectedTenant();
    if (!session || !tenant) return;
    void apiFetch<Array<{ nav: NavItem[]; acceso: 'completo' | 'solo_lectura' }>>(
      config, session, tenant, '/me/modules/plan',
    )
      .then((modulos) => {
        const porRuta: Record<string, 'completo' | 'solo_lectura'> = {};
        for (const m of modulos) for (const item of m.nav ?? []) porRuta[item.path] = m.acceso;
        setAcceso(porRuta);
      })
      // Si falla, el menú se queda como lo dibujó el servidor: sin candados,
      // que es exactamente lo de antes. El tope igual lo aplica la API.
      .catch(() => setAcceso({}));
  }, [session, config]);
  return acceso;
}

function Navegacion({ nav }: { nav: NavItem[] }) {
  const acceso = useAccesoPorPlan();
  return (
    <nav aria-label="Principal" className="flex flex-wrap items-center gap-4">
      {nav.map((item) => {
        const conCandado = acceso[item.path] === 'solo_lectura';
        return (
          <a
            key={item.path}
            href={item.path}
            className={conCandado ? 'text-sm text-muted' : 'text-sm text-body'}
            title={conCandado ? 'Tu plan no incluye esta función: puedes mirar, no cambiar.' : undefined}
          >
            {item.label}
            {conCandado && (
              <span aria-label="incluido en un plan superior" className="ml-1" role="img">
                🔒
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
}

function CerrarSesion() {
  const { supabase } = useSession();
  return (
    <button
      type="button"
      className="text-sm text-muted"
      onClick={() => void supabase.auth.signOut().then(() => (window.location.href = '/login'))}
    >
      Cerrar sesión
    </button>
  );
}

/**
 * Shell de la app (SPEC §29): encabezado con el lockup inline, navegación
 * armada desde GET /me/modules (un módulo apagado desaparece sin desplegar),
 * selector de negocio y modo día/noche. Funciona a 360 px.
 */
export function AppShell({ config, marcaSvg, nav, sinMargen, children }: ShellProps) {
  return (
    <SessionProvider config={config}>
      <RequireSession>
        <div className="min-h-screen bg-bg">
          <SoporteAviso />
          <header className="border-b border-line bg-raised">
            <div className="mx-auto flex max-w-contenido flex-wrap items-center gap-4 px-4 py-3">
              <a href="/" className="marca" aria-label="IAxTi, inicio"
                 dangerouslySetInnerHTML={{ __html: marcaSvg }} />
              <Navegacion nav={nav} />
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <TenantSwitcher />
                <Campana />
                <ModeToggle />
                <CerrarSesion />
              </div>
            </div>
          </header>
          <main className={sinMargen ? '' : 'mx-auto max-w-contenido px-4 py-8'}>{children}</main>
        </div>
      </RequireSession>
    </SessionProvider>
  );
}
