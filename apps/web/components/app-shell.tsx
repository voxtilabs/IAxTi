'use client';

import type { ReactNode } from 'react';
import { ModeToggle, RequireSession, SessionProvider, useSession, type PublicConfig } from '@iaxti/ui/react';
import { TenantSwitcher } from './tenant-switcher';

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
          <header className="border-b border-line bg-raised">
            <div className="mx-auto flex max-w-contenido flex-wrap items-center gap-4 px-4 py-3">
              <a href="/" className="marca" aria-label="IAxTi, inicio"
                 dangerouslySetInnerHTML={{ __html: marcaSvg }} />
              <nav aria-label="Principal" className="flex flex-wrap items-center gap-4">
                {nav.map((item) => (
                  <a key={item.path} href={item.path} className="text-sm text-body">
                    {item.label}
                  </a>
                ))}
              </nav>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <TenantSwitcher />
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
