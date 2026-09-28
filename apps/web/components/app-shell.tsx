'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  MarcaJelly,
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
  useMarcaSvg,
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
  ChevronDown,
} from 'lucide-react';
import { AvisoResultado } from '@iaxti/ui/react';
import { SoporteAviso } from './soporte-aviso';
import { PaletaComandos } from './paleta-comandos';
import { AgenteGeneral } from './agente-general';
import { TenantSwitcher } from './tenant-switcher';
import { Campana } from './campana';
import { PestanasAjustes } from './pestanas-ajustes';
import { queBarraMostrar, type NavItem } from '../lib/nav';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';
import { rutasConCandado } from '../lib/candados';

// El tipo vive en `lib/nav` para no cerrar un ciclo con las pestañas de
// ajustes, que el propio shell renderiza. Se re-exporta porque las páginas
// ya lo importan desde acá.
export type { NavItem } from '../lib/nav';

interface ShellProps {
  config: PublicConfig;
  marcaSvg: string;
  /**
   * El menú que trajo el servidor, o `null` si no pudo preguntarle a la API
   * (#679).
   *
   * `null` no es lo mismo que `[]`. Antes eran el mismo valor y la pantalla los
   * dibujaba igual: sin barra y sin una palabra. Con `null` el navegador lo pide
   * por su cuenta —ahí hay sesión— y si tampoco se puede, se dice.
   */
  nav: NavItem[] | null;
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

/**
 * Qué grupos se PUEDEN plegar. Ojo: se pueden, no arrancan plegados (#635).
 *
 * Configuración arrancaba plegada desde #387, y el motivo era bueno: «dieciséis
 * destinos sueltos en el menú, dieciséis decisiones para alguien que solo quería
 * cambiar una cosa». Pero ese problema ya lo resolvió el agrupado por sección —
 * de 16 entradas quedaron 5— y el plegado se quedó encima de un arreglo que ya
 * funcionaba. Con el grupo abierto la barra tiene 13 entradas, que es una barra
 * lateral normal.
 *
 * Lo que costaba tenerlo plegado: las 17 pantallas de configuración quedaban
 * detrás de un rótulo idéntico a «TRABAJO» y «CLIENTES», que no se pueden tocar.
 * Ahí viven conectar WhatsApp y prender la IA, o sea lo primero que alguien
 * necesita hacer. Reportado tal cual: «no veo los botones en la izquierda».
 */
const PLEGABLES = new Set(['Configuración']);

/**
 * Las secciones de ajustes, en orden (#387).
 *
 * Dieciséis destinos sueltos en el menú eran dieciséis decisiones para
 * alguien que solo quería cambiar una cosa. Se agrupan en cinco, y cada
 * pantalla lleva arriba las pestañas de su sección.
 *
 * El orden es de acá; la pertenencia la declara cada `module.yaml`. Una
 * sección que llegue sin estar en esta lista se dibuja igual, al final.
 */
const ORDEN_SECCIONES = ['Inteligencia', 'Canales', 'Tu negocio', 'Integraciones', 'Cuenta'];

const ICONO_SECCION: Record<string, LucideIcon> = {
  Inteligencia: Bot,
  Canales: Plug,
  'Tu negocio': SlidersHorizontal,
  Integraciones: Webhook,
  Cuenta: CreditCard,
};

/** Las entradas agrupadas por sección, en el orden de arriba. */
function porSeccion(items: NavItem[]): Array<[string, NavItem[]]> {
  const por = new Map<string, NavItem[]>();
  for (const item of items) {
    const s = item.seccion ?? 'Cuenta';
    por.set(s, [...(por.get(s) ?? []), item]);
  }
  const conocidas = ORDEN_SECCIONES.filter((s) => por.has(s));
  const resto = [...por.keys()].filter((s) => !ORDEN_SECCIONES.includes(s)).sort();
  return [...conocidas, ...resto].map((s) => [s, por.get(s)!] as const);
}

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
  const tenant = useSelectedTenant();
  const [resultado, setResultado] = useState<{ tenant: string; token: string; rutas: Set<string> } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!session || !tenant) return;
    void Promise.all([
      // Qué rutas trae cada módulo: el menú llega aplanado y ahí ya se
      // perdió de qué módulo salió cada item.
      fetch(`${config.apiUrl}/v1/me/modules`, { cache: 'no-store', signal: controller.signal }).then(
        (r) => r.json() as Promise<Array<{ id: string; nav: NavItem[] }>>,
      ),
      apiFetch<Array<{ id: string; acceso: 'completo' | 'solo_lectura' }>>(
        config, session, tenant, '/me/modules/acceso', { signal: controller.signal },
      ),
    ])
      .then(([modulos, acceso]) => {
        if (!controller.signal.aborted) setResultado({ tenant, token: session.access_token, rutas: rutasConCandado(modulos, acceso) });
      })
      // Si falla, el menú queda como lo dibujó el servidor: sin candados,
      // que es exactamente lo de antes. El tope igual lo aplica la API.
      .catch(() => { if (!controller.signal.aborted) setResultado(null); });
    return () => controller.abort();
  }, [session, config, tenant]);
  return resultado?.tenant === tenant && resultado?.token === session?.access_token
    ? resultado.rutas : new Set();
}

/** Dónde se recuerda si esta persona plegó un grupo. Por navegador, nada más. */
const recuerdo = (titulo: string) => `iaxti-menu-${titulo.toLowerCase()}`;

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
  const plegable = PLEGABLES.has(titulo);
  // Abierto salvo que ESTA persona lo haya plegado. Antes era `useState` a
  // secas, así que volvía a plegarse en cada navegación: abrirlo no servía de
  // nada dos clics después. Se lee en un efecto y no en el inicializador porque
  // esto se renderiza primero en el servidor, donde no hay `localStorage`, y
  // leerlo ahí sería un desajuste de hidratación.
  const [abierto, setAbierto] = useState(true);
  useEffect(() => {
    if (!plegable) return;
    try {
      if (window.localStorage.getItem(recuerdo(titulo)) === 'plegado') setAbierto(false);
    } catch {
      // Navegador con el almacenamiento bloqueado: se queda abierto, que es el
      // estado que no esconde nada.
    }
  }, [plegable, titulo]);
  useEffect(() => {
    if (contieneActiva) setAbierto(true);
  }, [contieneActiva]);

  const alternar = () => {
    setAbierto((v) => {
      try {
        window.localStorage.setItem(recuerdo(titulo), v ? 'plegado' : 'abierto');
      } catch {
        // Igual que arriba: no recordarlo es peor que fallar, pero no es fallar.
      }
      return !v;
    });
  };
  return (
    <SidebarGroup>
      {plegable ? (
        <SidebarGroupLabel asChild>
          {/* Con flecha, y que gira con el estado: sin eso se ve IGUAL que
              «TRABAJO» y «CLIENTES», que son rótulos y no hacen nada. El `(5)`
              solo no alcanza — se lee como «hay cinco cosas en algún lado», no
              como «apriétame». */}
          <button
            type="button"
            aria-expanded={abierto}
            onClick={alternar}
            className="flex w-full items-center gap-1.5 text-left hover:text-ink"
          >
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform ${abierto ? '' : '-rotate-90'}`}
              aria-hidden
            />
            {titulo} ({titulo === 'Configuración' ? porSeccion(items).length : items.length})
          </button>
        </SidebarGroupLabel>
      ) : (
        <SidebarGroupLabel>{titulo}</SidebarGroupLabel>
      )}
      {abierto && (
        <SidebarGroupContent>
          <SidebarMenu>
            {/* Configuración se muestra por SECCIÓN y no por pantalla: eran
                dieciséis entradas para alguien que solo quería cambiar una
                cosa. Cada sección lleva a su primera pantalla, y ahí arriba
                están las pestañas del resto (#387). */}
            {titulo === 'Configuración'
              ? porSeccion(items).map(([seccion, dentro]) => {
                  const Icono = ICONO_SECCION[seccion] ?? Settings;
                  const aqui = dentro.some((i) => i.path === activa);
                  // Con candado solo si TODAS las de la sección lo tienen:
                  // una sección con algo usable no se marca como cerrada.
                  const cerrada = dentro.every((i) => candados.has(i.path));
                  return (
                    <SidebarMenuItem key={seccion}>
                      <SidebarMenuButton asChild isActive={aqui} tooltip={seccion}>
                        <Link href={dentro[0].path} prefetch={false}>
                          <Icono />
                          <span>{seccion}</span>
                          {cerrada && (
                            <Lock
                              className="ml-auto size-3.5 shrink-0 text-muted"
                              aria-label="incluido en un plan superior"
                            />
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })
              : items.map((item) => {
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
                    <Link href={item.path} prefetch={false}>
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
                    </Link>
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

function Barra({ nav, marcaSvg, candados }: { nav: NavItem[]; marcaSvg: string; candados: Set<string> }) {
  const firma = useMarcaSvg(marcaSvg);
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
    <Sidebar collapsible="icon" variant="floating">
      <SidebarHeader>
        {/* Plegada, conserva el isotipo como acceso al inicio y oculta
            el nombre y el selector para no desbordar los iconos. */}
        <Link href="/" prefetch={false} className="pulso-brand" aria-label="IAxTi, inicio">
          <MarcaJelly />
          <span className="group-data-[collapsible=icon]:hidden">
            <span className="pulso-brand-name">IAxTi</span>
            <span className="pulso-brand-caption">Tu negocio, conectado</span>
          </span>
        </Link>
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
          className="marca-pie block px-2 py-1 text-muted group-data-[collapsible=icon]:hidden"
          dangerouslySetInnerHTML={{ __html: firma }}
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
export function AppShell(props: ShellProps) {
  return <SessionProvider config={props.config}><RequireSession>
    <ContenidoShell {...props} />
  </RequireSession></SessionProvider>;
}

/**
 * El menú, pedido desde el navegador cuando el servidor no pudo (#679).
 *
 * El servidor del web pregunta por la red interna y a veces no le contestan
 * —justo después de un despliegue, mientras la API arranca—. El navegador llega
 * por la URL pública, que es otro camino: si uno falla, el otro suele andar.
 *
 * Solo corre cuando hace falta (`hace`), así que el camino feliz queda exacto
 * como estaba: ni una petición más.
 */
function useNavDeRespaldo(hace: boolean): {
  nav: NavItem[] | null;
  fallo: boolean;
  reintentar: () => void;
} {
  const { config } = useSession();
  const [nav, setNav] = useState<NavItem[] | null>(null);
  const [fallo, setFallo] = useState(false);
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    if (!hace) return;
    const controller = new AbortController();
    setFallo(false);
    fetch(`${config.apiUrl}/v1/me/modules`, { cache: 'no-store', signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`contestó ${r.status}`);
        return r.json() as Promise<Array<{ nav: NavItem[] }>>;
      })
      .then((modulos) => {
        if (!controller.signal.aborted) setNav(modulos.flatMap((m) => m.nav));
      })
      .catch(() => {
        // `abort` también pasa por acá y no es un fallo: si se abortó, esta
        // pantalla ya no está mirando.
        if (!controller.signal.aborted) setFallo(true);
      });
    return () => controller.abort();
  }, [hace, config.apiUrl, intento]);
  return { nav, fallo, reintentar: () => setIntento((n) => n + 1) };
}

function ContenidoShell({ marcaSvg, nav: navDelServidor, sinMargen, children }: ShellProps) {
  // Menú y pestañas comparten la misma lectura; no duplicar módulos/acceso.
  const candados = useModulosConCandado();
  const respaldo = useNavDeRespaldo(navDelServidor === null);
  // La decisión de qué mostrar y cuándo avisar vive en `lib/nav.ts` y está
  // probada ahí (#679): las pruebas del web corren sin DOM, y una regla de tres
  // ramas escondida en este archivo no se probaría nunca.
  const { items: nav, avisar: sinPoderPreguntar } = queBarraMostrar({
    delServidor: navDelServidor,
    delNavegador: respaldo.nav,
    falloElNavegador: respaldo.fallo,
  });
  const ruta = usePathname();
  const pagina = nav.find((item) => item.path === ruta || ruta?.startsWith(`${item.path}/`));
  return (
    <>
        {/* La bandeja es a ancho completo y la barra arranca plegada: es la
            pantalla de tres paneles, y ahí cada píxel de ancho es una
            columna que se ve. */}
        <SidebarProvider defaultOpen={!sinMargen} className={sinMargen ? 'pulso-workspace pulso-workspace-inbox' : 'pulso-workspace'}>
          <Barra nav={nav} marcaSvg={marcaSvg} candados={candados} />
          <SidebarInset>
            <SoporteAviso />
            <header className="pulso-topbar flex items-center gap-3 border-b border-line px-6 py-3">
              <SidebarTrigger />
              <div className="pulso-context">
                <span>{pagina?.grupo ?? 'Tu espacio de trabajo'}</span>
                <strong>{pagina?.label ?? (ruta === '/' ? 'Puesta en marcha' : 'IAxTi')}</strong>
              </div>
              <div className="ml-auto flex items-center gap-3">
                {/* IAxTi va en la barra de TODA la app y no en una pantalla
                    suya: configurar conversando solo sirve si está donde
                    estás (#493). Primero él, después buscar: pedir es lo
                    que se hace más seguido. */}
                <AgenteGeneral />
                <PaletaComandos nav={nav} />
                <Campana />
                <ModeToggle />
              </div>
            </header>
            {/* Un menú vacío no puede ser el mensaje de error (#679). Antes
                la barra desaparecía y la pantalla no decía nada: quien la miraba
                concluía que el producto se rompió, que es lo que pasó el 27/09.
                Va acá, debajo de la cabecera y dentro del alto completo, para
                que también se vea en la bandeja —que va a ancho completo y sin
                contenedor—. */}
            {sinPoderPreguntar ? (
              <div className={sinMargen ? 'shrink-0 px-6 pt-3' : 'pulso-content mx-auto w-full max-w-contenido pt-3'}>
                <AvisoResultado persistente tono="warning">
                  No pudimos cargar el menú: ni desde el servidor ni desde este navegador. Lo que
                  estás viendo funciona igual, pero la barra va a estar vacía hasta que la API
                  vuelva a contestar.{' '}
                  <button type="button" className="underline" onClick={respaldo.reintentar}>
                    Reintentar
                  </button>
                </AvisoResultado>
              </div>
            ) : null}
            <div className={sinMargen ? 'min-h-0 min-w-0 flex-1' : 'pulso-content mx-auto w-full max-w-contenido'}>
              {/* Las pestañas de la sección van DENTRO del contenido y las pone
                  el shell, no cada página (#387). Como layout de
                  `app/ajustes/` quedarían por fuera: el layout envuelve a
                  la página, y la página es la que renderiza este shell.
                  Puestas acá, una pantalla de ajustes nueva las tiene sin
                  que nadie se acuerde. */}
              <PestanasAjustes items={nav} candados={candados} />
              {children}
            </div>
          </SidebarInset>
        </SidebarProvider>
    </>
  );
}
