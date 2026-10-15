import { describe, expect, it } from 'vitest';
import {
  destinoQueCubre,
  destinosQuePuedeAbrir,
  puedeAbrirLaRuta,
  queBarraMostrar,
  type NavItem,
} from '../lib/nav';

/**
 * Qué barra se muestra y cuándo se avisa (#679).
 *
 * El defecto no fue de dibujo: fue de decisión. «No pude preguntarle a la API» y
 * «este plan no trae módulos» eran el mismo valor, y la pantalla los mostraba
 * igual — sin barra y sin una palabra—. Acá están separados, y separados se
 * pueden probar sin navegador.
 */
const ITEMS = [{ label: 'Contactos', path: '/contactos', permission: 'crm.contacts.read' }];

describe('queBarraMostrar', () => {
  it('lo del servidor manda cuando llegó', () => {
    const r = queBarraMostrar({ delServidor: ITEMS, delNavegador: null, falloElNavegador: false });
    expect(r).toEqual({ items: ITEMS, avisar: false });
  });

  it('una lista VACÍA del servidor es una respuesta, no un problema', () => {
    // Un plan sin módulos es legítimo. Si esto avisara, el producto estaría
    // gritando por algo que está bien configurado.
    const r = queBarraMostrar({ delServidor: [], delNavegador: ITEMS, falloElNavegador: true });
    expect(r).toEqual({ items: [], avisar: false });
  });

  it('si el servidor no pudo, se usa lo que trajo el navegador', () => {
    // El servidor pregunta por la red interna y el navegador por la pública:
    // son dos caminos, y cuando uno se cae el otro suele andar. Eso es lo que
    // convierte una pantalla sin barra en una pantalla normal.
    const r = queBarraMostrar({ delServidor: null, delNavegador: ITEMS, falloElNavegador: false });
    expect(r).toEqual({ items: ITEMS, avisar: false });
  });

  it('mientras el navegador todavía pregunta, no se avisa nada', () => {
    // Un aviso que aparece y se va solo enseña a ignorar los avisos.
    const r = queBarraMostrar({ delServidor: null, delNavegador: null, falloElNavegador: false });
    expect(r).toEqual({ items: [], avisar: false });
  });

  it('si ninguno de los dos pudo, se avisa', () => {
    // Éste es el criterio del issue: un menú vacío no puede volver a ser el
    // mensaje de error.
    const r = queBarraMostrar({ delServidor: null, delNavegador: null, falloElNavegador: true });
    expect(r).toEqual({ items: [], avisar: true });
  });
});

/**
 * El `permission` de cada entrada del menú no lo leía nadie (#814).
 *
 * Se prueba acá, en la decisión, por la misma razón que `queBarraMostrar`:
 * las pruebas del web corren sin DOM, y una regla de tres ramas escondida en
 * un `.tsx` no se prueba nunca.
 */
describe('qué destinos puede abrir esta persona (#814)', () => {
  const MENU: NavItem[] = [
    { label: 'Bandeja', path: '/bandeja', permission: 'conversations.read' },
    { label: 'Contactos', path: '/contactos', permission: 'crm.contacts.read' },
    { label: 'Auditoría', path: '/ajustes/auditoria', permission: 'audit.read' },
    { label: 'Roles', path: '/ajustes/roles', permission: 'roles.read' },
  ];

  it('deja solo los que tienen su permiso', () => {
    const visibles = destinosQuePuedeAbrir(MENU, ['conversations.read', 'crm.contacts.read']);
    expect(visibles.map((i) => i.path)).toEqual(['/bandeja', '/contactos']);
  });

  it('con todos los permisos, el menú no cambia', () => {
    const todos = MENU.map((i) => i.permission);
    expect(destinosQuePuedeAbrir(MENU, todos)).toEqual(MENU);
  });

  /**
   * La rama que importa, y la que un `if (!permisos)` escribiría al revés.
   * `null` es «no pudimos averiguarlo», no «ningún permiso»: esconder el menú
   * por un error transitorio deja a la persona sin nada y sin explicación.
   */
  it('si no se pudo averiguar (null), se muestra TODO', () => {
    expect(destinosQuePuedeAbrir(MENU, null)).toEqual(MENU);
  });

  it('un conjunto VACÍO sí es una respuesta: no hay a dónde ir', () => {
    expect(destinosQuePuedeAbrir(MENU, [])).toEqual([]);
  });

  it('un permiso que nadie declara no agrega entradas', () => {
    expect(destinosQuePuedeAbrir(MENU, ['inventado.permiso'])).toEqual([]);
  });

  it('no inventa el orden: deja el que trajo el servidor', () => {
    const visibles = destinosQuePuedeAbrir(MENU, ['roles.read', 'conversations.read']);
    expect(visibles.map((i) => i.path)).toEqual(['/bandeja', '/ajustes/roles']);
  });
});

/**
 * Y si entra por URL, ¿se abre? (#815)
 *
 * #814 escondió del menú lo que no se puede abrir, y eso es esconder la
 * puerta: pegar `/ajustes/roles` en la barra de direcciones siendo USER
 * montaba la pantalla igual, que pedía sus datos y mostraba el texto crudo del
 * 403. La guarda del shell cruza la ruta contra esta decisión.
 */
describe('puedeAbrirLaRuta (#815)', () => {
  const MENU: NavItem[] = [
    { label: 'Bandeja', path: '/bandeja', permission: 'conversations.read' },
    { label: 'Contactos', path: '/contactos', permission: 'crm.contacts.read' },
    { label: 'Roles', path: '/ajustes/roles', permission: 'roles.read' },
  ];
  /** Lo que tiene el rol más común, que es el que choca con esto. */
  const DE_USER = ['conversations.read', 'crm.contacts.read'];

  it('con el permiso, se abre', () => {
    expect(puedeAbrirLaRuta({ destinos: MENU, ruta: '/bandeja', permisos: DE_USER })).toEqual({
      puede: true,
    });
  });

  it('sin el permiso, no se abre, y dice qué destino era', () => {
    // El destino sale en la respuesta porque el aviso lo nombra: «Roles pide un
    // permiso que tu rol no tiene» dice bastante más que «no tienes acceso».
    const puerta = puedeAbrirLaRuta({ destinos: MENU, ruta: '/ajustes/roles', permisos: DE_USER });
    expect(puerta).toEqual({ puede: false, destino: MENU[2] });
  });

  /**
   * La rama que no se puede escribir al revés.
   *
   * `null` es «el arranque todavía no llegó» o «no se pudo resolver», no
   * «ningún permiso». Negar acá le parpadearía un «esto no es para ti» en cada
   * recarga a quien sí tiene acceso: el primer render de TODA carga pasa por
   * este caso.
   */
  it('mientras no se sabe (null), se abre', () => {
    expect(puedeAbrirLaRuta({ destinos: MENU, ruta: '/ajustes/roles', permisos: null })).toEqual({
      puede: true,
    });
  });

  it('un conjunto VACÍO sí cierra: un rol sin permisos no tiene a dónde ir', () => {
    expect(puedeAbrirLaRuta({ destinos: MENU, ruta: '/ajustes/roles', permisos: [] }).puede).toBe(
      false,
    );
  });

  it('una ruta que ninguna entrada cubre se abre (defecto permitir)', () => {
    // `/` y las otras tres están enumeradas con su motivo en
    // `RUTAS_SIN_REGLA_DE_PERMISO`, y la guarda de
    // `menu-lleva-a-alguna-parte.test.ts` mantiene esa lista honesta.
    expect(puedeAbrirLaRuta({ destinos: MENU, ruta: '/', permisos: [] }).puede).toBe(true);
  });

  it('sin menú que consultar no se cierra nada', () => {
    // Si el catálogo no contestó (#679) la lista llega vacía. Dejar a todo el
    // mundo fuera del producto porque no pudimos leer el menú sería cambiar una
    // barra vacía por una pantalla vacía.
    expect(puedeAbrirLaRuta({ destinos: [], ruta: '/ajustes/roles', permisos: [] }).puede).toBe(
      true,
    );
  });

  it('una ficha hereda el permiso de su sección', () => {
    // `/contactos/abc-123` no tiene entrada propia y no por eso está sin regla:
    // es la misma pantalla con un id adentro.
    expect(
      puedeAbrirLaRuta({ destinos: MENU, ruta: '/contactos/abc-123', permisos: [] }).puede,
    ).toBe(false);
    expect(
      puedeAbrirLaRuta({ destinos: MENU, ruta: '/contactos/abc-123', permisos: DE_USER }).puede,
    ).toBe(true);
  });

  /**
   * El defecto que había que no escribir, acá como afirmación.
   *
   * Si la guarda se cruzara contra el `nav` ya filtrado, la entrada de Roles no
   * estaría en la lista, «no calza ninguna» ganaría y el defecto permisivo
   * abriría la pantalla: la guarda compilaría, se vería prolija y no cerraría
   * absolutamente nada. Por eso el shell le pasa `todosLosDestinos`.
   */
  it('cruzarlo contra la lista FILTRADA no cerraría nada', () => {
    const filtrado = destinosQuePuedeAbrir(MENU, DE_USER);
    expect(puedeAbrirLaRuta({ destinos: filtrado, ruta: '/ajustes/roles', permisos: DE_USER }).puede).toBe(
      true,
    );
    expect(puedeAbrirLaRuta({ destinos: MENU, ruta: '/ajustes/roles', permisos: DE_USER }).puede).toBe(
      false,
    );
  });
});

describe('destinoQueCubre (#815)', () => {
  it('gana la entrada más específica, no la primera que calza', () => {
    // Con `/ajustes` y `/ajustes/roles` declarados, abrir roles tiene que
    // exigir `roles.read`. Resolverlo por orden de llegada haría que el permiso
    // efectivo dependiera de en qué orden el catálogo concatena los módulos.
    const menu: NavItem[] = [
      { label: 'Ajustes', path: '/ajustes', permission: 'tenant.settings' },
      { label: 'Roles', path: '/ajustes/roles', permission: 'roles.read' },
    ];
    expect(destinoQueCubre(menu, '/ajustes/roles')?.permission).toBe('roles.read');
    expect(destinoQueCubre([...menu].reverse(), '/ajustes/roles')?.permission).toBe('roles.read');
  });

  it('no calza por prefijo a medias', () => {
    const menu: NavItem[] = [{ label: 'Contactos', path: '/contactos', permission: 'crm.contacts.read' }];
    expect(destinoQueCubre(menu, '/contactos-viejos')).toBeNull();
  });

  it('sin ruta todavía, no calza nada', () => {
    // `usePathname()` puede no tener ruta; eso no es una ruta sin permiso.
    expect(destinoQueCubre([{ label: 'B', path: '/bandeja', permission: 'conversations.read' }], null)).toBeNull();
  });
});
