'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  IAXTI_LOCKUP_SVG,
  ModeToggle,
  RequireSession,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  SessionProvider,
  useSession,
  type PublicConfig,
} from '@iaxti/ui/react';
import {
  Bot,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  CreditCard,
  FileText,
  Inbox,
  KeyRound,
  Lock,
  LogOut,
  Megaphone,
  MessageSquare,
  Plug,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Target,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { SoporteAviso } from './soporte-aviso';
import { PaletaComandos } from './paleta-comandos';
import { TenantSwitcher } from './tenant-switcher';
import { Campana } from './campana';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';
import { rutasConCandado } from '../lib/candados';

export interface NavItem {
  label: string;
  path: string;
  permission: string;
  grupo?: string;
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
 * El orden de los grupos.
 *
 * El `grupo` lo declara cada `module.yaml` —con 23 destinos, una tabla
 * paralela acá se desincroniza y el destino nuevo aparece suelto abajo sin
 * que nadie lo note— pero el ORDEN sí es decisión de la interfaz: primero
 * lo que se hace todos los días, después los datos, y la configuración al
 * final y plegada.
 *
 * Un grupo que llegue sin estar en esta lista se dibuja igual, al final:
 * quedarse fuera del menú por no haber tocado este archivo sería
 * exactamente el problema que el `grupo` en el manifiesto viene a evitar.
 */
const ORDEN = ['Trabajo', 'Clientes', 'Configuración'];
const PLEGADOS = new Set(['Configuración']);

/**
 * Un icono por destino.
 *
 * Esto sí es una tabla en el frontend, y a propósito: un icono que falta
 * no rompe nada —cae en el genérico— mientras que una ruta que falta manda
 * a un 404. No merece la misma ceremonia.
 */
const ICONOS: Record<string, LucideIcon> = {
  '/bandeja': Inbox,
  '/agenda': CalendarDays,
  '/campanas': Megaphone,
  '/reportes': ChartNoAxesColumn,
  '/contactos': Users,
  '/empresas': Building2,
  '/oportunidades': Target,
  '/ajustes/bandeja': SlidersHorizontal,
  '/ajustes/canales': Plug,
  '/ajustes/plantillas': FileText,
  '/ajustes/automatizaciones': Workflow,
  '/ajustes/ia': Bot,
  '/ajustes/conocimiento': Sparkles,
  '/ajustes/equipo': Users,
  '/ajustes/roles': KeyRound,
  '/ajustes/api': KeyRound,
  '/ajustes/webhooks': Webhook,
  '/ajustes/campos': SlidersHorizontal,
  '/ajustes/etiquetas': Tag,
  '/ajustes/notificaciones': MessageSquare,
  '/ajustes/facturacion': CreditCard,
  '/ajustes/pagos': CreditCard,
  '/ajustes/auditoria': ScrollText,
};

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

function Grupo({
  titulo,
  items,
  candados,
  activa,
}: {
  titulo: string;
  items: NavItem[];
  candados: Set<string>;
  activa: string | null;
}) {
  // Un grupo plegado que contiene la página actual se abre solo: si no, el
  // menú no sabría decir dónde estás.
  const contieneActiva = items.some((i) => i.path === activa);
  const [abierto, setAbierto] = useState(!PLEGADOS.has(titulo) || contieneActiva);
  useEffect(() => {
    if (contieneActiva) setAbierto(true);
  }, [contieneActiva]);

  const plegable = PLEGADOS.has(titulo);
  return (
    <SidebarGroup>
      {plegable ? (
        <SidebarGroupLabel asChild>
          <button
            type="button"
            aria-expanded={abierto}
            onClick={() => setAbierto((v) => !v)}
            className="w-full text-left"
          >
            {titulo} ({items.length})
          </button>
        </SidebarGroupLabel>
      ) : (
        <SidebarGroupLabel>{titulo}</SidebarGroupLabel>
      )}
      {abierto && (
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map((item) => {
              const conCandado = candados.has(item.path);
              const Icono = ICONOS[item.path] ?? Settings;
              return (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    isActive={item.path === activa}
                    tooltip={
                      conCandado
                        ? `${item.label} · tu plan no lo incluye: puedes mirar, no cambiar`
                        : item.label
                    }
                  >
                    <a href={item.path}>
                      <Icono />
                      <span>{item.label}</span>
                      {conCandado && (
                        // El candado NO esconde: bajar de plan nunca borra
                        // (SPEC §6). Va a la derecha del item, con su
                        // explicación en el tooltip.
                        <Lock
                          className="ml-auto size-3.5 shrink-0 text-muted"
                          aria-label="incluido en un plan superior"
                        />
                      )}
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

function CerrarSesion() {
  const { supabase } = useSession();
  return (
    <SidebarMenuButton
      onClick={() => void supabase.auth.signOut().then(() => (window.location.href = '/login'))}
    >
      <LogOut />
      <span>Cerrar sesión</span>
    </SidebarMenuButton>
  );
}

function Barra({ nav, marcaSvg }: { nav: NavItem[]; marcaSvg: string }) {
  const candados = useModulosConCandado();
  const activa = usePathname();

  const grupos = useMemo(() => {
    const por = new Map<string, NavItem[]>();
    for (const item of nav) {
      const g = item.grupo ?? 'Configuración';
      por.set(g, [...(por.get(g) ?? []), item]);
    }
    const conocidos = ORDEN.filter((g) => por.has(g));
    const resto = [...por.keys()].filter((g) => !ORDEN.includes(g)).sort();
    return [...conocidos, ...resto].map((g) => [g, por.get(g)!] as const);
  }, [nav]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* Plegada, la barra son 3 rem de iconos: el lockup y el selector
            no caben y se ocultan en vez de desbordarse. El destino sigue
            alcanzable desde cada icono. */}
        <a href="/" className="marca block px-2 py-1 group-data-[collapsible=icon]:hidden"
           aria-label="IAxTi, inicio"
           dangerouslySetInnerHTML={{ __html: IAXTI_LOCKUP_SVG }} />
        {/* Para quien maneja varios negocios esto es lo más importante del
            menú, y en el encabezado viejo estaba perdido entre otros tres
            controles. Acá es lo primero. */}
        <div className="group-data-[collapsible=icon]:hidden">
          <TenantSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {grupos.map(([titulo, items]) => (
          <Grupo key={titulo} titulo={titulo} items={items} candados={candados} activa={activa} />
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <CerrarSesion />
          </SidebarMenuItem>
        </SidebarMenu>
        {/* El lockup de VoxTi Labs, discreto: IAxTi es lo que el cliente
            usa; VoxTi Labs es quien lo hace. Antes vivía en un pie que la
            bandeja no llevaba —o sea que en la pantalla donde más se está,
            no aparecía. Acá está siempre. */}
        <a
          href="https://voxtilabs.cl"
          target="_blank"
          rel="noreferrer"
          aria-label="VoxTi Labs"
          className="marca-pie block px-2 py-1 text-muted opacity-70 transition-opacity hover:opacity-100 group-data-[collapsible=icon]:hidden"
          dangerouslySetInnerHTML={{ __html: marcaSvg }}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Shell de la app (SPEC §29, #295).
 *
 * Antes era una fila de enlaces de texto que a 1280 px ya se doblaba en dos
 * líneas: la marca, siete destinos, el selector de negocio, la campana, el
 * modo y "Cerrar sesión", todo al mismo peso. Ahora es una barra lateral
 * con grupos, estado activo e iconos, y los controles de sesión abajo.
 *
 * Lo que NO cambió, porque es la regla: la navegación sale de
 * `GET /me/modules` y un módulo apagado desaparece sin desplegar (SPEC §26).
 * El `grupo` de cada destino también viene de ahí.
 */
export function AppShell({ config, marcaSvg, nav, sinMargen, children }: ShellProps) {
  return (
    <SessionProvider config={config}>
      <RequireSession>
        {/* La bandeja es a ancho completo y la barra arranca plegada: es la
            pantalla de tres paneles, y ahí cada píxel de ancho es una
            columna que se ve. */}
        <SidebarProvider defaultOpen={!sinMargen}>
          <Barra nav={nav} marcaSvg={marcaSvg} />
          <SidebarInset>
            <SoporteAviso />
            <header className="flex items-center gap-2 border-b border-line bg-raised px-4 py-3">
              <SidebarTrigger />
              <div className="ml-auto flex items-center gap-3">
                <PaletaComandos nav={nav} />
                <Campana />
                <ModeToggle />
              </div>
            </header>
            <main className={sinMargen ? '' : 'mx-auto w-full max-w-contenido px-4 py-8'}>
              {children}
            </main>
          </SidebarInset>
        </SidebarProvider>
      </RequireSession>
    </SessionProvider>
  );
}
