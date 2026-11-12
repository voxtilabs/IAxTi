'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  SidebarTrigger,
  SessionProvider,
  useSession,
  type PublicConfig,
} from '@iaxti/ui/react';
import {
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  CreditCard,
  FileText,
  Inbox,
  KeyRound,
  ListTodo,
  Lock,
  LogOut,
  Megaphone,
  MessageSquare,
  Plug,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Tag,
  Target,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
  ChevronDown,
} from 'lucide-react';
import { AvisoResultado } from '@iaxti/ui/react';
import { ProveedorDeArranque, useArranque, usePieza } from './arranque';
import { SoporteAviso } from './soporte-aviso';
import { PaletaComandos } from './paleta-comandos';
import { AgenteGeneral } from './agente-general';
import { ProveedorAgente } from './agente/estado';
import { TenantSwitcher } from './tenant-switcher';
import { Campana } from './campana';
import { PestanasAjustes } from './pestanas-ajustes';
import { destinosQuePuedeAbrir, puedeAbrirLaRuta, queBarraMostrar, type NavItem } from '../lib/nav';
import { rutasConCandado } from '../lib/candados';
import { SinPermiso } from './sin-permiso';

// El tipo vive en `lib/nav` para no cerrar un ciclo con las pestañas de
// ajustes, que el propio shell renderiza. Se re-exporta porque las páginas
// ya lo importan desde acá.
export type { NavItem } from '../lib/nav';

interface ShellProps {
  config: PublicConfig;
  /**
   * El menú que trajo el servidor, o `null` si no pudo preguntarle a la API
   * (#679).
   *
   * `null` no es lo mismo que `[]`. Antes eran el mismo valor y la pantalla los
   * dibujaba igual: sin barra y sin una palabra. Con `null` el navegador lo pide
   * por su cuenta —ahí hay sesión— y si tampoco se puede, se dice.
   */
  nav: NavItem[] | null;
  /** Pantallas a ancho completo (la bandeja, el tablero): sin contenedor ni padding. */
  sinMargen?: boolean;
  /**
   * Arrancar con la barra plegada (#1155).
   *
   * Era parte de `sinMargen` —una prop, dos efectos— y eso obligaba a elegir
   * entre ancho completo con la barra escondida, o la barra a la vista con la
   * página encajonada en 1.120 px. El tablero de oportunidades necesita el
   * ancho Y la barra: es una pantalla donde se navega, no un lugar donde te
   * encerrás como la bandeja.
   *
   * Por qué la bandeja sí la pliega: sus TRES paneles —lista, chat, ficha— no
   * caben de otra forma, y quien abre una conversación se queda ahí.
   */
  barraPlegada?: boolean;
  /**
   * Pantallas que ocupan el alto, no el ancho (#1135): el asistente.
   *
   * No es `sinMargen`. Esa prop hace DOS cosas —quitar el contenedor Y
   * arrancar con la barra plegada— porque la bandeja necesita cada píxel de
   * ancho para sus tres paneles. El asistente es al revés: quiere su columna
   * centrada y la barra abierta, y lo que necesita es que el chat llegue
   * hasta abajo en vez de que la página scrollee.
   *
   * Separadas porque conflarlas obligaría a elegir entre un chat corto o una
   * barra plegada sin motivo.
   */
  altoCompleto?: boolean;
  children: ReactNode;
}

/**
 * El orden de los grupos (#1324).
 *
 * El `grupo` lo declara cada `module.yaml` —con 23 destinos, una tabla
 * paralela acá se desincroniza y el destino nuevo aparece suelto abajo sin
 * que nadie lo note— pero el ORDEN sí es decisión de la interfaz: primero lo
 * que se hace todos los días, después con quién se hace, después el
 * asistente, después los números, y los ajustes aparte, al final.
 *
 * El asistente ya no abre la barra: su grupo es UNA entrada, y lo que tiene
 * adentro —chat, conocimiento, automatizaciones— viaja en pestañas. Antes el
 * asistente abría y su configuración vivía en «Configuración →
 * Inteligencia»: dos casas para lo mismo, y la queja del dueño —«no sé si la
 * IA lo gestiona»— salía de ahí.
 *
 * Un grupo que llegue sin estar en esta lista se dibuja igual, al final:
 * quedarse fuera del menú por no haber tocado este archivo sería
 * exactamente el problema que el `grupo` en el manifiesto viene a evitar.
 */
const ORDEN = ['Trabajo', 'Clientes', 'Asistente', 'Resultados', 'Ajustes'];

/**
 * Qué grupos van ABAJO, separados del resto por un filete (#1324).
 *
 * «Ajustes» es lo que se toca una vez y se deja: va después de un borde, como
 * «Cerrar sesión», para que el trabajo del día y lo que se configura a las
 * tres de la mañana no pesen igual a la vista. El resto de los grupos queda
 * arriba, sin filete.
 */
const AL_FINAL = new Set(['Ajustes']);

/**
 * Qué grupos se PUEDEN plegar. Ojo: se pueden, no arrancan plegados (#635).
 *
 * Ajustes arrancaba plegado desde #387, y el motivo era bueno: «dieciséis
 * destinos sueltos en el menú, dieciséis decisiones para alguien que solo quería
 * cambiar una cosa». Pero ese problema ya lo resolvió el agrupado por sección —
 * de 16 entradas quedaron 5— y el plegado se quedó encima de un arreglo que ya
 * funcionaba.
 *
 * Lo que costaba tenerlo plegado: las 17 pantallas de ajustes quedaban
 * detrás de un rótulo idéntico a «TRABAJO» y «CLIENTES», que no se pueden tocar.
 * Ahí viven conectar WhatsApp y prender la IA, o sea lo primero que alguien
 * necesita hacer. Reportado tal cual: «no veo los botones en la izquierda».
 *
 * El grupo Asistente NO está: tiene una entrada y esconderla sería esconder
 * el producto entero (#1324).
 */
const PLEGABLES = new Set(['Ajustes']);

/**
 * Qué grupos se muestran POR SECCIÓN: una entrada por sección y no una por
 * pantalla (#387, #1324).
 *
 * Ajustes lo necesitaba —dieciséis pantallas sueltas eran dieciséis
 * decisiones— y el asistente lo necesita por el motivo contrario: sus tres
 * pantallas son UNA cosa con tres vistas, y verlas como tres entradas era
 * lo que partía «dónde configuro la IA» en dos respuestas. La misma
 * maquinaria para los dos, porque el día que se escriba dos veces es el día
 * que arreglan distinto.
 */
const POR_SECCION = new Set(['Asistente', 'Ajustes']);

/**
 * Las secciones de los grupos «por sección», en orden (#387, #1324).
 *
 * La de Ajustes agrupaba dieciséis destinos sueltos; la del Asistente junta
 * su chat, su conocimiento y sus automatizaciones. Cada pantalla lleva
 * arriba las pestañas de su sección.
 *
 * El orden es de acá; la pertenencia la declara cada `module.yaml`. Una
 * sección que llegue sin estar en esta lista se dibuja igual, al final.
 */
const ORDEN_SECCIONES = ['Asistente', 'Canales', 'Tu negocio', 'Integraciones', 'Cuenta'];

const ICONO_SECCION: Record<string, LucideIcon> = {
  Asistente: Bot,
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
  '/pendientes': ListTodo,
  '/ajustes/bandeja': SlidersHorizontal,
  '/ajustes/canales': Plug,
  '/ajustes/plantillas': FileText,
  '/ajustes/automatizaciones': Workflow,
  '/ajustes/ia': Bot,
  '/ajustes/conocimiento': BookOpen,
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
 * El orden preferido de las pantallas, por `path` (#1324).
 *
 * Dentro de un grupo, el orden con que llegan los módulos del catálogo es el
 * orden del `readdir` que los carga: «Agenda, Bandeja, Oportunidades,
 * Pendientes», o sea el orden de quién lo trajo y no el de cómo se usa. Lo
 * que se hace al empezar el día tiene su propio orden, y es una sugerencia
 * desde acá por el mismo motivo que `ORDEN`: lo que no esté en la lista no
 * se esconde ni se rompe, llega después y en su orden de llegada.
 *
 * `/ajustes/ia` está por el Asistente: su sección se muestra como UNA
 * entrada, y el destino de esa entrada es su primera pantalla.
 */
const ORDEN_POR_PATH = [
  '/bandeja',
  '/oportunidades',
  '/agenda',
  '/pendientes',
  '/ajustes/ia',
];

/** Las pantallas de un grupo, con las conocidas primero y en su orden. */
function ordenarPorPath(items: NavItem[]): NavItem[] {
  return [...items].sort((a, b) => {
    const pa = ORDEN_POR_PATH.indexOf(a.path);
    const pb = ORDEN_POR_PATH.indexOf(b.path);
    // Las desconocidas van después de las conocidas, en su orden de llegada:
    // `sort` es estable, así que comparar igual las deja donde estaban.
    return (pa < 0 ? ORDEN_POR_PATH.length : pa) - (pb < 0 ? ORDEN_POR_PATH.length : pb);
  });
}

/**
 * El menú dice la verdad sobre el plan (issue 215).
 *
 * `GET /modules/catalogo` lo pide la página desde el SERVIDOR, sin sesión y sin
 * tenant: dibuja la navegación antes de saber quién mira, y es el catálogo del
 * despliegue para todos (#629). Acá ya hay sesión, así que se pregunta
 * `modules/acceso` —la única que depende del negocio— y lo que el plan no
 * incluye queda con candado, en vez de dejar que alguien escriba media regla y
 * se entere al guardar.
 *
 * No se esconde: bajar de plan nunca borra (SPEC §6), y mostrar lo que se
 * estaría comprando vale más que ocultarlo.
 */
function useModulosConCandado(): Set<string> {
  /**
   * Dos llamadas menos (#761): el catálogo de módulos y el acceso por plan
   * vienen los dos en el arranque.
   *
   * El catálogo seguía pidiéndose por `fetch` directo a `/v1/modules/catalogo`
   * —pública, sin sesión— y el acceso por `apiFetch`. Las dos cosas están ahora
   * en `/arranque`, y lo que se gana no es solo el viaje: el acceso por plan
   * abría su propia transacción con su `BEGIN`, su `set_config` y su `COMMIT`.
   *
   * Si el arranque falló, esto devuelve el conjunto vacío: el menú queda como lo
   * dibujó el servidor, sin candados, que es exactamente lo de antes. El tope
   * igual lo aplica la API.
   */
  const { arranque } = useArranque();
  const acceso = usePieza('acceso');
  return useMemo(() => {
    if (!arranque || !acceso.puedeVerla || !acceso.dato) return new Set<string>();
    return rutasConCandado(arranque.modulos, acceso.dato);
  }, [arranque, acceso.puedeVerla, acceso.dato]);
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
  // Se muestra por sección o pantalla por pantalla: lo decide el grupo, no
  // este archivo por cada uno (#1324).
  const porSecciones = POR_SECCION.has(titulo);
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
    <SidebarGroup className={AL_FINAL.has(titulo) ? 'mt-2 border-t border-line pt-2' : undefined}>
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
            {/* Por sección, se cuenta SECCIONES y no pantallas: es la cantidad
                de entradas que la persona va a ver. */}
            {titulo} ({porSecciones ? porSeccion(items).length : items.length})
          </button>
        </SidebarGroupLabel>
      ) : (
        <SidebarGroupLabel>{titulo}</SidebarGroupLabel>
      )}
      {abierto && (
        <SidebarGroupContent>
          <SidebarMenu>
            {/* Los grupos de POR_SECCION se muestran por SECCIÓN y no por
                pantalla. Ajustes: eran dieciséis entradas para alguien que
                solo quería cambiar una cosa (#387). Asistente: sus tres
                pantallas son una, y el menú las cuenta como una (#1324).
                Cada sección lleva a su primera pantalla, y ahí arriba están
                las pestañas del resto. */}
            {porSecciones
              ? porSeccion(items).map(([seccion, dentro]) => {
                  const destino = ordenarPorPath(dentro)[0];
                  const Icono = ICONO_SECCION[seccion] ?? Settings;
                  const aqui = dentro.some((i) => i.path === activa);
                  // Con candado solo si TODAS las de la sección lo tienen:
                  // una sección con algo usable no se marca como cerrada.
                  const cerrada = dentro.every((i) => candados.has(i.path));
                  /* Una sección que se llama como su grupo no puede repetir
                     el nombre: el rótulo de arriba ya lo dijo, y una entrada
                     que dice lo mismo que su grupo no dice a dónde va. Se
                     rotula con el nombre de su primera pantalla — «Tu
                     asistente» dentro de ASISTENTE (#1324). */
                  const nombre = seccion === titulo ? destino.label : seccion;
                  return (
                    <SidebarMenuItem key={seccion}>
                      <SidebarMenuButton asChild isActive={aqui} tooltip={nombre}>
                        <Link href={destino.path} prefetch={false}>
                          <Icono />
                          <span>{nombre}</span>
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
              : ordenarPorPath(items).map((item) => {
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

function Barra({ nav, candados }: { nav: NavItem[]; candados: Set<string> }) {
  const activa = usePathname();

  const grupos = useMemo(() => {
    const por = new Map<string, NavItem[]>();
    for (const item of nav) {
      // Sin grupo declarado, a ajustes: es la salida por si acaso de
      // `el-menu-tiene-grupos.test.ts`, y «lo que no dije dónde va» es un
      // ajuste antes que una tarea.
      const g = item.grupo ?? 'Ajustes';
      por.set(g, [...(por.get(g) ?? []), item]);
    }
    const conocidos = ORDEN.filter((g) => por.has(g));
    const resto = [...por.keys()].filter((g) => !ORDEN.includes(g)).sort();
    return [...conocidos, ...resto].map((g) => [g, por.get(g)!] as const);
  }, [nav]);

  /**
   * Marca la barra cuando su navegación no cabe (#1142).
   *
   * El atributo lo lee `pulso-vivo.css` para atenuar el último tramo: sin él,
   * una barra desbordada se ve igual que una que termina ahí, y la persona no
   * tiene forma de saber que hay dos pantallas más abajo.
   *
   * Se recalcula al cambiar de tamaño y cuando cambia el contenido —el menú
   * llega del servidor y puede crecer después del primer dibujo—, no una vez
   * al montar.
   */
  const contenidoDeLaBarra = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nodo = contenidoDeLaBarra.current;
    if (!nodo) return;
    const revisar = () => {
      nodo.dataset.desborda = nodo.scrollHeight > nodo.clientHeight + 1 ? 'true' : 'false';
    };
    revisar();
    const observador = new ResizeObserver(revisar);
    observador.observe(nodo);
    for (const hijo of Array.from(nodo.children)) observador.observe(hijo as Element);
    window.addEventListener('resize', revisar);
    return () => {
      observador.disconnect();
      window.removeEventListener('resize', revisar);
    };
  });

  return (
    <Sidebar collapsible="icon" variant="floating">
      <SidebarHeader>
        {/* Plegada, conserva el isotipo como acceso al inicio y oculta
            el nombre y el selector para no desbordar los iconos. */}
        <Link href="/" prefetch={false} className="pulso-brand" aria-label="IAxTi, inicio">
          <MarcaJelly />
          {/* Sin el claim (#1108). Medido a 1440×900: pedía 252 px de borde
              derecho y la cabecera termina en 247, así que estaba RECORTADO —
              con `white-space: nowrap` no hay dónde partirlo. Además costaba
              20 px de alto en una barra a la que le faltaban 162 para mostrar
              su último grupo. El claim vive en la portada y en el correo, que
              es donde alguien lo lee por primera vez; acá lo leía todos los
              días quien ya sabe qué es IAxTi. */}
          <span className="group-data-[collapsible=icon]:hidden">
            <span className="pulso-brand-name">IAxTi</span>
          </span>
        </Link>
        {/* Para quien maneja varios negocios esto es lo más importante del
            menú, y en el encabezado viejo estaba perdido entre otros tres
            controles. Acá es lo primero. */}
        <div className="group-data-[collapsible=icon]:hidden">
          <TenantSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent ref={contenidoDeLaBarra}>
        {grupos.map(([titulo, items]) => (
          <Grupo key={titulo} titulo={titulo} items={items} candados={candados} activa={activa} />
        ))}
      </SidebarContent>

      <SidebarFooter>
        {/* Sin filete (#1108): el pie ya está separado por su relleno y por el
            borde del área que hace scroll, así que la línea era una tercera
            forma de decir lo mismo — y costaba altura en la barra que no
            llegaba a mostrar su último grupo. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <CerrarSesion />
          </SidebarMenuItem>
        </SidebarMenu>
        {/* La firma de quien lo hace, en texto y apagada (#1157).
            Era el lockup a color de 21 px, y en una barra donde todo lo demás
            es texto gris con un icono de línea, la única marca a color se
            lleva el ojo cada vez que mirás el menú —y no es dónde el ojo
            tiene que ir—. La atribución se queda; el lockup a color vive en
            el login y en SuperAdmin, que es donde corresponde. */}
        <a
          href="https://voxtilabs.cl"
          target="_blank"
          rel="noreferrer"
          className="block px-2 py-1 text-rotulo text-muted hover:text-body group-data-[collapsible=icon]:hidden"
        >
          VoxTi Labs
        </a>
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
 * Lo que NO cambió, porque es la regla: la navegación sale del catálogo de
 * módulos y uno apagado en el despliegue desaparece sin desplegar (SPEC §26).
 * El `grupo` de cada destino también viene de ahí.
 */
export function AppShell(props: ShellProps) {
  /**
   * El proveedor del arranque va DENTRO de `RequireSession` (#761).
   *
   * Afuera pediría `/arranque` sin sesión y comería un 401 en cada carga; y
   * tiene que envolver todo el contenido porque las piezas las leen componentes
   * de cualquier profundidad —la campana de avisos, el aviso de soporte, los
   * atajos de la bandeja—, que es exactamente por qué estaban pidiendo cada uno
   * lo suyo.
   */
  return <SessionProvider config={props.config}><RequireSession>
    <ProveedorDeArranque>
      {/* El hilo con IAxTi vive acá arriba (#1129): el popup de la barra y la
          conversación incrustada en «Tu asistente» son la MISMA, y para eso el
          estado tiene que estar por encima de las dos. Adentro de
          `RequireSession` por lo mismo que el arranque: sin sesión no hay a
          quién preguntarle. */}
      <ProveedorAgente>
        <ContenidoShell {...props} />
      </ProveedorAgente>
    </ProveedorDeArranque>
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
    fetch(`${config.apiUrl}/v1/modules/catalogo`, { cache: 'no-store', signal: controller.signal })
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

function ContenidoShell({ nav: navDelServidor, sinMargen, barraPlegada, altoCompleto, children }: ShellProps) {
  // Menú y pestañas comparten la misma lectura; no duplicar módulos/acceso.
  const candados = useModulosConCandado();
  const respaldo = useNavDeRespaldo(navDelServidor === null);
  // La decisión de qué mostrar y cuándo avisar vive en `lib/nav.ts` y está
  // probada ahí (#679): las pruebas del web corren sin DOM, y una regla de tres
  // ramas escondida en este archivo no se probaría nunca.
  const { items: todosLosDestinos, avisar: sinPoderPreguntar } = queBarraMostrar({
    delServidor: navDelServidor,
    delNavegador: respaldo.nav,
    falloElNavegador: respaldo.fallo,
  });
  /**
   * Y de esos, los que esta persona puede abrir (#814).
   *
   * El `permission` de cada entrada estaba declarado en los 19 manifiestos,
   * tipado, servido por el catálogo y redeclarado en `NavItem` — y no lo leía
   * nadie. Un USER veía las 25 entradas y quince le devolvían 403 al entrar.
   *
   * `arranque.permisos` es `null` mientras el arranque no llega y cuando el
   * conjunto no se pudo resolver: en los dos casos se muestra todo, que es
   * exactamente lo de antes. La regla de las tres ramas vive en `lib/nav.ts`
   * y está probada ahí.
   */
  const { arranque: arranqueDelShell } = useArranque();
  const nav = useMemo(
    () => destinosQuePuedeAbrir(todosLosDestinos, arranqueDelShell?.permisos ?? null),
    [todosLosDestinos, arranqueDelShell],
  );
  const ruta = usePathname();
  const pagina = nav.find((item) => item.path === ruta || ruta?.startsWith(`${item.path}/`));
  /**
   * Y esta ruta, ¿se puede abrir? (#815)
   *
   * #814 sacó del menú los destinos sin permiso y con eso creímos haber
   * cerrado algo: no. Entrar por URL —un enlace pasado entre compañeros de
   * distinto rol, un favorito— montaba la pantalla igual, y ninguna `page.tsx`
   * comprueba nada, así que terminaba mostrando el 403 de su primera petición
   * como si el producto se hubiera roto.
   *
   * Va acá, una vez, y no en un `<ConPermiso>` por pantalla: la variante por
   * pantalla se puede olvidar en la siguiente, y de hecho se olvidó en las 31
   * que ya existen.
   *
   * `todosLosDestinos` y NO `nav`, que es el filtrado. Es el punto entero: con
   * el filtrado, «no tengo el permiso» y «ninguna entrada cubre esta ruta»
   * serían el mismo caso y la guarda no cerraría nada. La regla vive en
   * `lib/nav.ts` —las pruebas del web corren sin DOM— junto con la lista de
   * las cuatro rutas que a propósito no tienen regla.
   */
  const puerta = puedeAbrirLaRuta({
    destinos: todosLosDestinos,
    ruta,
    permisos: arranqueDelShell?.permisos ?? null,
  });
  return (
    <>
        {/* La bandeja es a ancho completo y la barra arranca plegada: es la
            pantalla de tres paneles, y ahí cada píxel de ancho es una
            columna que se ve. */}
        <SidebarProvider
          defaultOpen={!barraPlegada}
          className={
            sinMargen
              ? 'pulso-workspace pulso-workspace-inbox'
              : altoCompleto
                ? 'pulso-workspace pulso-workspace-alto'
                : 'pulso-workspace'
          }
        >
          <Barra nav={nav} candados={candados} />
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
            <div
              className={
                sinMargen
                  ? 'min-h-0 min-w-0 flex-1'
                  : altoCompleto
                    ? 'pulso-content mx-auto flex min-h-0 w-full max-w-contenido flex-1 flex-col'
                    : 'pulso-content mx-auto w-full max-w-contenido'
              }
            >
              {/* Las pestañas de la sección van DENTRO del contenido y las pone
                  el shell, no cada página (#387). Como layout de
                  `app/ajustes/` quedarían por fuera: el layout envuelve a
                  la página, y la página es la que renderiza este shell.
                  Puestas acá, una pantalla de ajustes nueva las tiene sin
                  que nadie se acuerde. */}
              {puerta.puede ? (
                <>
                  <PestanasAjustes items={nav} candados={candados} />
                  {children}
                </>
              ) : (
                /* En lugar de la página, no encima: montarla y taparla la
                   dejaría pedir sus datos igual —un 403 por petición en los
                   registros, y un parpadeo de contenido antes del aviso—. El
                   `p-6` es para la bandeja, que va a ancho completo y sin
                   contenedor: sin eso el panel quedaría pegado al borde. */
                <div className={sinMargen ? 'p-6' : ''}>
                  <SinPermiso que={puerta.destino.label} />
                </div>
              )}
            </div>
          </SidebarInset>
        </SidebarProvider>
    </>
  );
}
