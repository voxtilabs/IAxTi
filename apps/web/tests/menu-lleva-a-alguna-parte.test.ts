import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { RUTAS_SIN_REGLA_DE_PERMISO } from '../lib/nav';

/**
 * Un ítem del menú que lleva a un 404.
 *
 * La navegación NO la escribe el frontend: sale de `GET /modules/catalogo`, que
 * devuelve el `nav` declarado en cada `module.yaml`. Es a propósito —"el
 * frontend jamás hardcodea qué módulos existen"— y tiene un costo: el
 * manifiesto puede prometer una ruta que nadie construyó, y nada se queja
 * hasta que un cliente hace clic.
 *
 * Pasó: `calendar` declara `/agenda` y esa página no existe. El módulo es
 * `plan_min: base` y está activo, así que el ítem le aparece a cualquiera
 * con `calendar.read`.
 *
 * Y al revés: una página construida que ningún `nav` menciona es una
 * función terminada a la que no se llega por ningún lado.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const MODULOS = join(RAIZ, 'packages', 'modules');
const APP = join(__dirname, '..', 'app');

/** Las rutas que el menú promete, con el módulo que las declara. */
function rutasDelMenu(): Array<{ modulo: string; path: string }> {
  const salida: Array<{ modulo: string; path: string }> = [];
  for (const modulo of readdirSync(MODULOS)) {
    const yaml = join(MODULOS, modulo, 'module.yaml');
    if (!existsSync(yaml)) continue;
    const texto = readFileSync(yaml, 'utf8');
    const bloque = /^nav:\s*\n((?:\s+.*\n)+?)(?=^\S|$)/m.exec(texto);
    if (!bloque) continue;
    for (const m of bloque[1].matchAll(/path:\s*([^\s,}]+)/g)) {
      salida.push({ modulo, path: m[1] });
    }
  }
  return salida;
}

/** Las páginas que existen de verdad, como rutas. */
function paginas(dir = APP, prefijo = ''): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      salida.push(...paginas(join(dir, e.name), `${prefijo}/${e.name}`));
    } else if (e.name === 'page.tsx') {
      salida.push(prefijo || '/');
    }
  }
  return salida;
}

/** Todos los `.tsx` de una carpeta, para buscar quién enlaza a una ruta. */
function archivosDe(dir: string): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) salida.push(...archivosDe(join(dir, e.name)));
    else if (e.name.endsWith('.tsx')) salida.push(join(dir, e.name));
  }
  return salida;
}

/** `/contactos/[id]` cubre `/contactos/loquesea`. */
function existeRuta(ruta: string, todas: string[]): boolean {
  return todas.some((p) => {
    if (p === ruta) return true;
    const patron = '^' + p.replace(/\[[^\]]+\]/g, '[^/]+') + '$';
    return new RegExp(patron).test(ruta);
  });
}

describe('el menú no promete páginas que no existen', () => {
  const menu = rutasDelMenu();
  const todas = paginas();

  it('hay algo que mirar', () => {
    expect(menu.length).toBeGreaterThanOrEqual(10);
    expect(todas.length).toBeGreaterThanOrEqual(10);
  });

  it('cada ruta del nav tiene su página', () => {
    const rotas = menu.filter((x) => !existeRuta(x.path, todas));
    expect(
      rotas,
      'Estos ítems salen en el menú y llevan a un 404:\n' +
        rotas.map((x) => `  ${x.path} (declarado por ${x.modulo})`).join('\n') +
        '\nO se construye la página, o se saca del `nav` hasta que exista.',
    ).toEqual([]);
  });

/**
 * Las de `/ajustes` a las que se llega desde dentro, no desde el menú.
 *
 * El comentario de la guarda ya contemplaba el caso —«las demás se alcanzan
 * desde dentro del producto (una ficha, un detalle)»— pero el filtro miraba
 * solo el prefijo, así que una pantalla de detalle bajo `/ajustes` no tenía
 * dónde declararse.
 *
 * La excepción NO alcanza con escribirla: la prueba de más abajo exige que
 * algún componente enlace de verdad a esa ruta. Una exención que no se
 * comprueba es la forma más limpia de dejar una pantalla huérfana con
 * permiso.
 */
const DESDE_DENTRO: Record<string, string> = {
  '/ajustes/ia/detalle':
    'Se llega desde la conversación con IAxTi (#1135): «Tu asistente» es el chat, ' +
    'y acá está lo que quedó configurado. En el menú serían dos entradas para la ' +
    'misma cosa, y la segunda contradice que el chat sea la principal.',
};

  it('cada página de ajustes se alcanza desde el menú', () => {
    // Una página terminada que ningún nav menciona es trabajo que nadie
    // puede usar. Solo se revisan las de `/ajustes`: las demás se alcanzan
    // desde dentro del producto (una ficha, un detalle).
    const enMenu = new Set(menu.map((x) => x.path));
    const huerfanas = todas.filter(
      (p) =>
        p.startsWith('/ajustes/') &&
        !p.includes('[') &&
        !enMenu.has(p) &&
        !DESDE_DENTRO[p],
    );
    expect(
      huerfanas,
      'Estas páginas existen y no se llega a ellas desde ningún menú:\n' +
        huerfanas.map((p) => `  ${p}`).join('\n'),
    ).toEqual([]);
  });

  it('las que se alcanzan «desde dentro» tienen quién las enlace', () => {
    // Lo que vuelve real la excepción. Sin esto, `DESDE_DENTRO` sería una
    // lista de permisos para dejar pantallas huérfanas: se escribe el motivo
    // una vez, el enlace se borra en otro PR, y la guarda sigue verde.
    const fuentes = archivosDe(join(__dirname, '..', 'components'));
    for (const [ruta, motivo] of Object.entries(DESDE_DENTRO)) {
      expect(motivo.length, `${ruta} necesita un motivo escrito`).toBeGreaterThan(40);
      const enlazan = fuentes.filter((f) => readFileSync(f, 'utf8').includes(`"${ruta}"`));
      expect(enlazan.length, `nadie enlaza a ${ruta}: dejó de alcanzarse desde dentro`)
        .toBeGreaterThan(0);
    }
  });
});

/**
 * Lo mismo, para los pasos de la puesta en marcha.
 *
 * Cada paso declara dónde se resuelve (`ruta`) junto a su definición, por
 * el mismo motivo por el que el `nav` vive en el manifiesto: el módulo sabe
 * dónde está su cosa. Y por el mismo motivo hace falta esta guarda — al
 * escribirlo puse `/ajustes/negocio`, que no existe: el paso "Cuéntanos de
 * tu negocio" se resuelve en `/ajustes/ia`, donde está el configurador.
 */
describe('los pasos de la puesta en marcha llevan a alguna parte', () => {
  const fuente = readFileSync(
    join(RAIZ, 'packages', 'modules', 'organizations', 'domain', 'onboarding-pasos.ts'),
    'utf8',
  );
  const rutas = [...fuente.matchAll(/ruta:\s*'([^']+)'/g)].map((m) => m[1]);
  const todas = paginas();

  it('hay pasos con ruta que mirar', () => {
    expect(rutas.length).toBeGreaterThanOrEqual(4);
  });

  it('cada ruta declarada existe', () => {
    const rotas = rutas.filter((r) => !existeRuta(r, todas));
    expect(
      rotas,
      'Estos pasos mandan al negocio a un 404 en su primer día:\n' +
        rotas.map((r) => `  ${r}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * Ninguna pantalla queda sin regla de permiso por olvido (#815).
 *
 * La guarda de la ruta (`puedeAbrirLaRuta`) exige el `permission` de la entrada
 * de `nav` que cubre la ruta, y si ninguna la cubre, PERMITE. Ese defecto es el
 * correcto —negar por omisión dejaría una pantalla nueva mostrando «esto no es
 * para ti» hasta que alguien se acordara del manifiesto— pero sin esta prueba
 * sería un hueco silencioso: nadie podría decir cuántas rutas están pasando sin
 * regla, ni por qué.
 *
 * Es la misma forma que las dos guardas de arriba —cruzar el `nav` de los
 * manifiestos con lo que hay en `apps/web/app`— aplicada al tercer criterio del
 * issue. Y mira en los DOS sentidos: una pantalla nueva sin entrada de `nav` y
 * sin anotar pone esto rojo, y una anotación que ya sobra también, porque una
 * lista de excepciones que nadie poda deja de ser una lista de excepciones.
 */
describe('toda pantalla tiene su permiso o su motivo escrito (#815)', () => {
  const menu = rutasDelMenu();
  const todas = paginas();

  /** El mismo criterio de `destinoQueCubre`: una ficha está «en» su sección. */
  const laCubreElMenu = (pagina: string) =>
    menu.some(({ path }) => pagina === path || pagina.startsWith(`${path}/`));

  it('cada pantalla está cubierta por el menú o anotada con su motivo', () => {
    const sinAnotar = todas.filter((p) => !laCubreElMenu(p) && !(p in RUTAS_SIN_REGLA_DE_PERMISO));
    expect(
      sinAnotar,
      'Estas pantallas se abren sin comprobar ningún permiso y nadie escribió por qué:\n' +
        sinAnotar.map((p) => `  ${p}`).join('\n') +
        '\nO el módulo la declara en su `nav` con su `permission`, o va a' +
        ' `RUTAS_SIN_REGLA_DE_PERMISO` (apps/web/lib/nav.ts) con el motivo por el' +
        ' que no puede exigir uno.',
    ).toEqual([]);
  });

  it('no quedan anotaciones que ya sobran', () => {
    const sobran = Object.keys(RUTAS_SIN_REGLA_DE_PERMISO).filter(
      (p) => !todas.includes(p) || laCubreElMenu(p),
    );
    expect(
      sobran,
      'Estas rutas están anotadas como «sin regla» y ya no lo necesitan — la' +
        ' pantalla no existe, o el menú ya la cubre con su permiso:\n' +
        sobran.map((p) => `  ${p}`).join('\n'),
    ).toEqual([]);
  });

  /**
   * El shell cruza la ruta contra la lista SIN filtrar.
   *
   * Es el defecto que esta función invita a escribir: el shell tiene a mano
   * `nav`, que es el menú ya filtrado por permiso, y pasárselo se lee igual de
   * bien. Pero entonces «me falta el permiso» y «ninguna entrada cubre esta
   * ruta» serían el mismo caso —ninguna calza—, el defecto permisivo abriría
   * todo y la guarda no cerraría nada.
   *
   * La prueba de COMPORTAMIENTO sí existe y vive en el e2e
   * (`esqueletos-medidos.spec.ts`, «sin el permiso, la pantalla no se
   * dibuja»): con la lista filtrada, la ruta que la persona no puede abrir
   * deja de tener entrada, cae en el defecto permisivo y la pantalla vuelve a
   * dibujarse — o sea que el e2e se pondría rojo. Esta de acá es la que caza
   * el cambio ANTES de los doce minutos de CI, y por eso mira la llamada: las
   * pruebas del web corren sin DOM.
   *
   * `fuenteLimpia` (#569) para que el comentario que explica esto no sea lo que
   * la hace pasar.
   */
  it('el shell cruza la ruta contra la lista sin filtrar, no contra el menú', () => {
    const shell = fuenteLimpia(
      readFileSync(join(__dirname, '..', 'components', 'app-shell.tsx'), 'utf8'),
    );
    const llamada = /puedeAbrirLaRuta\(\{([^}]*)\}/.exec(shell);
    expect(
      llamada,
      'El shell ya no llama a `puedeAbrirLaRuta`: entrar por URL a una pantalla' +
        ' sin permiso volvió a dibujarla igual (#815).',
    ).not.toBeNull();
    expect(
      llamada?.[1],
      'La guarda tiene que recibir TODOS los destinos del catálogo. Con el `nav`' +
        ' ya filtrado por permiso, toda ruta cerrada se vuelve indistinguible de' +
        ' una ruta sin regla y la guarda no cierra nada.',
    ).toContain('destinos: todosLosDestinos');

    // Y que el resultado se USE. Llamarla e ignorar lo que devuelve deja la
    // guarda en el código, en verde, y la puerta abierta — que es la forma
    // que más veces tomó el defecto endémico de este repo: declarado en un
    // lado, aplicado en ninguno.
    expect(
      shell,
      'El shell llama a `puedeAbrirLaRuta` y no usa la respuesta: la pantalla' +
        ' se dibuja igual y la guarda solo parece estar vigilando (#815).',
    ).toMatch(/puerta\.puede\s*\?/);
    expect(
      shell,
      'La rama cerrada no dibuja `SinPermiso`: sin eso, quedarse sin permiso' +
        ' se ve como una pantalla en blanco (#815).',
    ).toContain('<SinPermiso');
  });

  it('las seis anotadas son las medidas, y cada motivo dice algo', () => {
    // El número está acá a propósito: que crezca tiene que costar una línea de
    // prueba y una explicación, no pasar sin que nadie lo mire.
    // /entrar-local (#1047) entra porque es donde se CONSIGUE la sesión local,
    // como /login — y su acceso lo gobiernan sus dos cerraduras de ambiente,
    // no un permiso: fuera de local la página es un 404.
    expect(Object.keys(RUTAS_SIN_REGLA_DE_PERMISO)).toEqual([
      '/',
      '/login',
      '/invitacion/[token]',
      '/webchat/[widgetId]',
      // #1167: la única de la lista que SÍ tiene permiso —su controlador exige
      // `automations.manage`— y entra por el otro motivo: se le sacó la entrada
      // del menú, y sin entrada el frontend no tiene de dónde derivarlo.
      '/campanas',
      '/entrar-local',
    ]);
    // Un motivo vacío o de tres palabras convierte la lista en un trámite.
    for (const [ruta, motivo] of Object.entries(RUTAS_SIN_REGLA_DE_PERMISO)) {
      expect(motivo.length, `El motivo de ${ruta} no explica nada.`).toBeGreaterThan(40);
    }
  });
});
