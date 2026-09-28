/**
 * Un destino del menú, tal como lo declara el `module.yaml` de su módulo y
 * lo entrega `GET /me/modules`.
 *
 * Vive acá y no en `app-shell.tsx` porque las pestañas de ajustes también
 * lo necesitan, y el shell las renderiza: importarlo de allá cerraba un
 * ciclo `app-shell → pestanas-ajustes → app-shell`. Lo cazó
 * dependency-cruiser, no yo.
 */
export interface NavItem {
  label: string;
  path: string;
  permission: string;
  /** En qué lista de la barra lateral va (#295). */
  grupo?: string;
  /** Con qué pantallas de ajustes comparte pestañas (#387). */
  seccion?: string;
}

/**
 * Un widget del inicio, tal como lo declara el `module.yaml` de su módulo
 * (#517).
 *
 * Estaban declarados y expuestos por `GET /me/modules` desde el principio, y
 * ningún componente los leía: el inicio mostraba la puesta en marcha para
 * siempre, también al negocio que terminó de configurarse hace medio año.
 *
 * El `id` es el contrato. Quién lo dibuja lo decide el frontend
 * (`components/inicio/widgets.tsx`); qué módulo lo trae y con qué permiso se
 * ve, el manifiesto. Así un módulo apagado se lleva el suyo sin desplegar,
 * igual que su entrada del menú.
 */
export interface WidgetItem {
  id: string;
  permission: string;
}

/**
 * La navegación, pedida UNA vez y cacheada (#400).
 *
 * Estaba copiada en 26 páginas, todas con `cache: 'no-store'`. Esas llamadas
 * salen del servidor del web SIN `x-tenant-id`, así que el limitador cae a
 * su último recurso —el cupo por IP— y las 26 comparten uno solo de 120 por
 * minuto. Next además precarga los enlaces del menú al pasar el cursor, y
 * cada precarga renderiza la página en el servidor: una llamada más cada
 * vez. Con la barra lateral de #295 hay más enlaces a la vista, así que se
 * agotaba en segundos y el producto respondía "Demasiadas solicitudes".
 *
 * Lo que devuelve son los módulos activos y su navegación: cambia cuando se
 * despliega, no entre dos clics. Un minuto de caché es más que suficiente, y
 * el costo es que un módulo recién encendido tarde hasta un minuto en
 * aparecer en el menú.
 */
export async function navDesdeLaApi(urlInterna: string): Promise<NavItem[] | null> {
  const modulos = await modulosDesdeLaApi(urlInterna);
  return modulos === null ? null : modulos.flatMap((m) => m.nav);
}

/**
 * Los widgets del inicio, de los módulos ACTIVOS (#517).
 *
 * Acá un fallo sí se traduce a lista vacía: el inicio sin widgets sigue siendo
 * el inicio. Lo que no puede quedar vacío en silencio es la navegación, que es
 * la pantalla entera (#679).
 */
export async function widgetsDesdeLaApi(urlInterna: string): Promise<WidgetItem[]> {
  return (await modulosDesdeLaApi(urlInterna))?.flatMap((m) => m.widgets ?? []) ?? [];
}

type ModuloConNav = { nav: NavItem[]; widgets?: WidgetItem[] };

/**
 * Cuándo se dejó de confiar en el caché, y por cuánto.
 *
 * Es del PROCESO, a propósito y sin nada que mantener: si esta instancia del web
 * acaba de tropezar, deja de leer el caché hasta que le vuelvan a contestar
 * bien. Ver `modulosDesdeLaApi`.
 */
let ultimoFallo = 0;
const DESCONFIAR_MS = 60_000;

async function pedirLosModulos(urlInterna: string, sinCache: boolean): Promise<ModuloConNav[]> {
  const res = await fetch(
    `${urlInterna}/v1/me/modules`,
    // El minuto de caché es del camino feliz y lo puso #400 para no agotar el
    // cupo por IP. Sin cache es el camino de recuperación.
    sinCache ? { cache: 'no-store' } : { next: { revalidate: 60 } },
  );
  if (!res.ok) throw new Error(`GET /v1/me/modules contestó ${res.status}`);
  return (await res.json()) as ModuloConNav[];
}

/**
 * Una sola lectura para las dos cosas, y `null` cuando no se pudo preguntar
 * (#679).
 *
 * Antes devolvía `[]` en los dos casos —«no hay módulos» y «no pude
 * preguntar»— y los dos se dibujaban igual: **sin menú, sin aviso, sin nada
 * en la pantalla que dijera que hubo un problema**. El comentario declaraba la
 * intención («la API puede no estar en un build local») y en producción eso se
 * traducía en que la navegación entera desaparecía.
 *
 * Medido contra staging el 27/09: la PRIMERA petición a `/` y a `/bandeja`
 * volvió sin un solo item de menú, y de la segunda en adelante con el menú
 * completo. Es lo que pasa después de cada despliegue — el web ya atiende, la
 * API todavía está arrancando, le contestan mal— y encima **el vacío se
 * cacheaba**: `revalidate: 60` guarda también lo que no es 200, así que un
 * tropiezo de un segundo dejaba a TODO el mundo sin menú hasta un minuto.
 *
 * Dos cosas, entonces. Un fallo se reintenta al tiro sin caché, porque el
 * problema suele durar menos que la petición. Y si vuelve a fallar, esta
 * instancia deja de leer el caché por un minuto: una entrada envenenada no se
 * puede borrar desde acá, pero sí se puede dejar de creer.
 */
async function modulosDesdeLaApi(urlInterna: string): Promise<ModuloConNav[] | null> {
  const desconfiando = Date.now() - ultimoFallo < DESCONFIAR_MS;
  try {
    const modulos = await pedirLosModulos(urlInterna, desconfiando);
    ultimoFallo = 0;
    return modulos;
  } catch (primero) {
    try {
      const modulos = await pedirLosModulos(urlInterna, true);
      ultimoFallo = 0;
      return modulos;
    } catch (segundo) {
      ultimoFallo = Date.now();
      // Se registra: el síntoma que esto produce —una pantalla sin barra— no
      // se parece en nada a la causa, y sin esta línea no había forma de unir
      // las dos cosas.
      console.error(
        '[nav] no se pudo leer GET /v1/me/modules, la barra se va a pedir desde el navegador:',
        (primero as Error).message,
        '/ reintento:',
        (segundo as Error).message,
      );
      return null;
    }
  }
}

/**
 * Qué barra mostrar, y cuándo avisar (#679).
 *
 * La decisión vive acá y no dentro del componente por una razón práctica: las
 * pruebas del web corren sin DOM —los componentes se prueban con Playwright— y
 * una regla de tres ramas escondida en un `.tsx` no se prueba nunca. Lo que
 * falló el 27/09 no fue dibujar: fue **decidir** que no poder preguntar se veía
 * igual que no tener módulos.
 */
export function queBarraMostrar(entrada: {
  /** Lo que trajo el servidor, o `null` si no pudo preguntar. */
  delServidor: NavItem[] | null;
  /** Lo que alcanzó a traer el navegador, o `null` si todavía no. */
  delNavegador: NavItem[] | null;
  /** Si el navegador ya intentó y tampoco pudo. */
  falloElNavegador: boolean;
}): { items: NavItem[]; avisar: boolean } {
  // Una lista vacía del servidor es una respuesta: este plan no trae módulos.
  // No lleva aviso, y pedirla de nuevo desde el navegador tampoco la va a
  // cambiar.
  if (entrada.delServidor !== null) return { items: entrada.delServidor, avisar: false };
  if (entrada.delNavegador !== null) return { items: entrada.delNavegador, avisar: false };
  // Mientras el navegador todavía está preguntando, no se avisa nada: un aviso
  // que aparece y se va solo enseña a ignorar los avisos.
  return { items: [], avisar: entrada.falloElNavegador };
}
