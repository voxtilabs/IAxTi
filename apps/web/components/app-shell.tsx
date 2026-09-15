'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ModeToggle, RequireSession, SessionProvider, useSession, type PublicConfig } from '@iaxti/ui/react';
import { SoporteAviso } from './soporte-aviso';
import { TenantSwitcher } from './tenant-switcher';
import { Campana } from './campana';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';
import { rutasConCandado } from '../lib/candados';

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
 * tenant: dibuja la navegación antes de saber quién mira. Acá ya hay sesión,
 * así que se pregunta `modules/acceso` y lo que el plan no incluye queda con
 * candado — en vez de dejar que alguien escriba media regla y se entere al
 * guardar.
 *
 * No se esconde: bajar de plan nunca borra (SPEC §6), y mostrar lo que se
 * estaría comprando vale más que ocultarlo.
 */
function useModulosConCandado(): Set<string> {
  const { session, config } = useSession();
  const [candados, setCandados] = useState<Set<string>>(new Set());
  useEffect(() => {
    const tenant = selectedTenant();
    if (!session || !tenant) return;
    void Promise.all([
      // Qué rutas trae cada módulo: el menú llega aplanado y ahí ya se
      // perdió de qué módulo salió cada item.
      fetch(`${config.apiUrl}/v1/me/modules`, { cache: 'no-store' }).then(
        (r) => r.json() as Promise<Array<{ id: string; nav: NavItem[] }>>,
      ),
      apiFetch<Array<{ id: string; acceso: 'completo' | 'solo_lectura' }>>(
        config, session, tenant, '/me/modules/acceso',
      ),
    ])
      .then(([modulos, acceso]) => setCandados(rutasConCandado(modulos, acceso)))
      // Si falla, el menú queda como lo dibujó el servidor: sin candados,
      // que es exactamente lo de antes. El tope igual lo aplica la API.
      .catch(() => setCandados(new Set()));
  }, [session, config]);
  return candados;
}

function Navegacion({ nav }: { nav: NavItem[] }) {
  const candados = useModulosConCandado();
  return (
    <nav aria-label="Principal" className="flex flex-wrap items-center gap-4">
      {nav.map((item) => {
        const conCandado = candados.has(item.path);
        return (
          <a
            key={item.path}
            href={item.path}
            className={conCandado ? 'text-sm text-muted' : 'text-sm text-body'}
            title={conCandado ? 'Tu plan no incluye esta función: puedes mirar, no cambiar.' : undefined}
          >
            {item.label}
            {conCandado && (
              <span role="img" aria-label="incluido en un plan superior" className="ml-1">
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
