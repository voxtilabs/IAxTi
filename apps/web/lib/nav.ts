/**
 * Un destino del menú, tal como lo declara el `module.yaml` de su módulo y
 * lo entrega `GET /modules/catalogo` (#629: antes `GET /me/modules`, que
 * prometía ser «los míos» y es el catálogo del despliegue).
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
 * Estaban declarados y expuestos por el catálogo desde el principio, y
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
    // `/modules/catalogo` y no `/me/modules` (#629): es el catálogo GLOBAL del
    // despliegue, no «los módulos de quien mira» — esta petición sale del
    // servidor sin sesión y sin tenant, así que no podría ser otra cosa. El
    // nombre viejo sigue contestando por el contrato de /v1, pero decía lo que
    // no era, y el menú se dibuja desde acá.
    `${urlInterna}/v1/modules/catalogo`,
    // El minuto de caché es del camino feliz y lo puso #400 para no agotar el
    // cupo por IP. Sin cache es el camino de recuperación.
    sinCache ? { cache: 'no-store' } : { next: { revalidate: 60 } },
  );
  if (!res.ok) throw new Error(`GET /v1/modules/catalogo contestó ${res.status}`);
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

/**
 * Qué destinos del menú puede abrir esta persona (#814).
 *
 * Los 19 `module.yaml` declaran 25 entradas de `nav`, cada una con su
 * `permission`. `packages/core/src/manifest.ts` lo tipa como campo
 * obligatorio, `GET /modules/catalogo` lo entrega tal cual, `NavItem` lo
 * redeclara acá arriba, y **no lo leía nadie**: `grep -n permission
 * app-shell.tsx` daba cero. Lo único que el shell consultaba era el candado
 * por PLAN (#215), que es otra cosa.
 *
 * Entonces un USER —el rol más común— veía las 25 entradas, y quince de ellas
 * exigen un permiso que no tiene: Auditoría, API, Roles, Automatizaciones,
 * Campañas, Facturación, Agenda, Canales, Campos, Embudos, Etiquetas, Equipo,
 * Webhooks, Conocimiento, Pagos, Plantillas, Ajustes. La página carga —ninguna
 * `page.tsx` comprueba nada— y todas sus llamadas vuelven 403. No es una fuga:
 * la API sí exige. Es un menú donde más de la mitad son callejones sin salida.
 *
 * ## Por qué esconder acá y no en los widgets
 *
 * `components/inicio/widgets.tsx` decidió a propósito NO comprobar permisos,
 * y su razón es buena: un widget PIDE sus datos, así que sin permiso la
 * petición falla y el widget no se dibuja — el servidor sigue mandando y no
 * queda un hueco. Un destino del menú no pide nada: es un enlace. Nadie lo
 * filtra por el camino, y el 403 llega recién después del clic.
 *
 * ## La regla de las tres ramas, que es donde está el defecto fácil
 *
 * `null` no es «ningún permiso»: es «no pudimos averiguarlo». El arranque
 * manda `permisos: null` cuando el conjunto no se pudo resolver, y entonces se
 * muestra TODO — igual que antes de este cambio. Esconder el menú por un error
 * transitorio deja a la persona sin nada y sin explicación, que es peor que
 * ofrecerle una puerta que se le va a cerrar.
 *
 * Un conjunto vacío SÍ es una respuesta: un rol propio sin permisos no tiene
 * a dónde ir, y un menú vacío es la verdad.
 */
export function destinosQuePuedeAbrir(
  items: NavItem[],
  permisos: readonly string[] | null,
): NavItem[] {
  if (permisos === null) return items;
  const tiene = new Set(permisos);
  return items.filter((item) => tiene.has(item.permission));
}

/**
 * Las rutas de `apps/web/app` que ninguna entrada del `nav` cubre, con su
 * motivo (#815).
 *
 * La guarda de abajo tiene defecto PERMITIR, y eso es a propósito: negar por
 * omisión convertiría cada pantalla nueva en un «esto no es para ti» hasta que
 * alguien se acordara de declararla en el manifiesto, y el día que
 * `GET /modules/catalogo` no conteste —que pasa, #679— dejaría a todo el mundo
 * sin producto en vez de sin menú.
 *
 * El costo de ese defecto es que una ruta sin regla no se distingue de un
 * olvido. Esta lista es lo que lo hace mirable: están escritas, con el motivo
 * por el que ninguna puede exigir un permiso.
 *
 * Medido el 14/10: `apps/web/app` tiene 31 `page.tsx` y los 19 manifiestos
 * declaran 25 entradas de `nav`, que cubren 27 de ellas —`/contactos/[id]` y
 * `/contactos/importar` quedan dentro de `/contactos`—. Estas son las cuatro
 * que faltan.
 *
 * `apps/web/tests/menu-lleva-a-alguna-parte.test.ts` mantiene la lista honesta
 * en los dos sentidos: una pantalla nueva que ningún `nav` cubra y que no esté
 * anotada acá pone la prueba roja, y una anotación que ya sobra también.
 */
export const RUTAS_SIN_REGLA_DE_PERMISO: Record<string, string> = {
  '/integraciones/drive/callback': 'Retorno OAuth personal: debe poder mostrar rechazo/expiración del intento aun sin permiso de negocio; el canje exige JWT humano, integrations.connect, pertenencia y PKCE en la API (#64).',
  '/': 'La puesta en marcha, que es a donde llega quien recién entró: no puede exigir nada. Cada widget que trae sí comprueba el suyo, por su cuenta (#517).',
  '/login': 'Se abre SIN sesión. Acá todavía no hay permisos que consultar, y de hecho es donde se consiguen.',
  '/invitacion/[token]': 'Quien acepta una invitación todavía no es parte del negocio: la credencial es el token del enlace, no un rol.',
  '/webchat/[widgetId]': 'El widget público, que carga en el sitio del cliente para un visitante anónimo: no hay sesión ni negocio elegido.',
};

/**
 * Qué entrada del menú cubre una ruta, si alguna (#815).
 *
 * El criterio de pertenencia es el que el shell ya usaba para rotular la barra
 * —`/contactos/abc-123` está «en» `/contactos`—, así que una ficha o un detalle
 * hereda el permiso de su sección en vez de quedar sin regla.
 *
 * Gana la entrada MÁS específica y no la primera que calce: si algún día
 * conviven `/ajustes` y `/ajustes/roles`, abrir roles tiene que exigir
 * `roles.read` y no el permiso de la pantalla de ajustes, que es el más barato
 * de los dos. Resolverlo por orden de llegada haría que el permiso efectivo
 * dependiera del orden en que el catálogo concatena los módulos.
 */
export function destinoQueCubre(destinos: NavItem[], ruta: string | null): NavItem | null {
  if (!ruta) return null;
  let elegido: NavItem | null = null;
  for (const destino of destinos) {
    // `${path}/` y no `path` a secas: sin la barra, `/ajustes/banderas` quedaría
    // «dentro» de `/ajustes/bandeja` el día que exista.
    if (destino.path !== ruta && !ruta.startsWith(`${destino.path}/`)) continue;
    if (elegido === null || destino.path.length > elegido.path.length) elegido = destino;
  }
  return elegido;
}

/**
 * Si esta persona puede ABRIR esta ruta, no solo verla en el menú (#815).
 *
 * `destinosQuePuedeAbrir` escondió del menú los destinos sin permiso (#814), y
 * esconder la puerta no es cerrarla: entrar por URL a `/ajustes/roles` siendo
 * USER seguía montando la pantalla, que pedía sus datos, comía un 403 y
 * mostraba el texto crudo del error. O sea decía «algo se rompió» donde lo que
 * pasa es «esto no es para ti». Los datos nunca estuvieron en riesgo —la API
 * exige el permiso en cada ruta y eso no cambia— pero un enlace pasado entre
 * compañeros de distinto rol llevaba a esa pantalla siempre.
 *
 * ## Las dos ramas donde esto se escribe mal
 *
 * **Se cruza contra la lista SIN filtrar.** Si se le pasara el `nav` ya
 * filtrado por `destinosQuePuedeAbrir`, una ruta cuyo permiso falta y una ruta
 * que ninguna entrada cubre serían el MISMO caso —ninguna calza— y con defecto
 * permitir la guarda no cerraría absolutamente nada: compilaría, pasaría una
 * prueba escrita de memoria y dejaría el agujero intacto.
 *
 * **`permisos === null` permite.** Es «no pudimos averiguarlo», no «ningún
 * permiso»: el arranque en vuelo manda `null` en el primer render de cada
 * carga. Negar ahí le parpadearía un «esto no es para ti» en cada recarga a
 * quien sí tiene acceso, y dejaría a todo el mundo fuera cuando el conjunto no
 * se pueda resolver. Un conjunto VACÍO sí es una respuesta y sí cierra: un rol
 * sin permisos no tiene a dónde ir. Misma regla de tres ramas que el menú, por
 * el mismo motivo.
 */
export function puedeAbrirLaRuta(entrada: {
  /** Todos los destinos del catálogo, SIN filtrar por permiso. */
  destinos: NavItem[];
  /** La ruta actual (`usePathname()`), o `null` si todavía no se sabe. */
  ruta: string | null;
  /** Lo que esta persona puede hacer, o `null` si no se pudo averiguar. */
  permisos: readonly string[] | null;
}): { puede: true } | { puede: false; destino: NavItem } {
  if (entrada.permisos === null) return { puede: true };
  const destino = destinoQueCubre(entrada.destinos, entrada.ruta);
  // Sin entrada que la cubra se permite, y el motivo de cada una de esas rutas
  // está escrito arriba, en `RUTAS_SIN_REGLA_DE_PERMISO`.
  //
  // `!destino.permission` parece inalcanzable mirando el tipo —`NavItem.permission`
  // es `string` obligatorio— y no lo es: estos destinos llegan como JSON desde
  // `GET /modules/catalogo`, así que el tipo describe lo que esperamos, no lo
  // que llega. Un manifiesto nuevo con la línea de `nav` incompleta haría
  // `undefined` acá, y comparar `undefined` contra la lista de permisos daría
  // «no puede» para todo el mundo: una entrada mal escrita dejaría a todos
  // afuera de su propia pantalla. Se prefiere abrir.
  if (destino === null || !destino.permission) return { puede: true };
  // `includes` y no un `Set` como hace `destinosQuePuedeAbrir`: ahí se filtran
  // N destinos y el Set se amortiza; acá se mira UN permiso, y construir el
  // Set cuesta más que el recorrido que evita.
  return entrada.permisos.includes(destino.permission)
    ? { puede: true }
    : { puede: false, destino };
}
