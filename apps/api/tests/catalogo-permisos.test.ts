import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * El catálogo de permisos no puede juntar polvo.
 *
 * Un permiso declarado y no verificado en ninguna parte es un permiso que
 * alguien le da a un rol creyendo que hace algo. Así estaban `users.invite`,
 * `users.read` y `users.manage`: declarados, dados al ADMIN, y sin una sola
 * ruta que los exigiera — no existía forma de invitar a nadie.
 *
 * Lo contrario es peor: una ruta que exige un permiso inexistente responde
 * 403 para siempre, incluso al dueño del negocio.
 */
const REPO = join(__dirname, '../../..');
const MODULOS = join(REPO, 'packages/modules');

function archivosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === 'dist') continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivosTs(ruta));
    else if (ruta.endsWith('.ts')) salida.push(ruta);
  }
  return salida;
}

function declarados(): Set<string> {
  const todos = new Set<string>();
  for (const modulo of readdirSync(MODULOS)) {
    const manifiesto = join(MODULOS, modulo, 'module.yaml');
    let crudo: string;
    try {
      crudo = readFileSync(manifiesto, 'utf8');
    } catch {
      continue; // Un módulo sin manifiesto lo caza el registry, no este test.
    }
    // El bloque `permissions:` es una lista plana hasta la siguiente clave.
    const bloque = crudo.split(/^permissions:$/m)[1]?.split(/^[a-z_]+:/m)[0] ?? '';
    for (const m of bloque.matchAll(/^ {2}- ([a-z0-9._]+)$/gm)) todos.add(m[1]);
  }
  return todos;
}

/**
 * Dónde se VERIFICA un permiso de verdad (#539).
 *
 * Esto contaba cualquier string con punto que apareciera en el código, y por
 * eso pasaba engañado: `base-roles.ts` REPARTE permisos —dice qué trae cada
 * rol— y eso no es verificarlos. Un permiso que solo estaba ahí contaba como
 * cumplido, así que `teams.manage` llevaba meses declarado, repartido a
 * SUPERVISOR y ADMIN, y sin una sola ruta que lo exija. Ni siquiera figuraba en
 * PENDIENTES, porque la guarda decía que estaba en uso.
 *
 * Ahora solo cuentan las formas en que un permiso de verdad decide algo. Y
 * `base-roles.ts` queda excluido explícitamente: repartir no es verificar.
 */
const FORMAS_DE_VERIFICAR: RegExp[] = [
  /@RequirePermission\('([^']+)'\)/g,
  // `actorCan(actor, 'x')`, `actorPuede('x')`, `permisos.has('x')`,
  // `puede('x')` — las cuatro formas que usa el repo para preguntar.
  /(?:actorCan|actorPuede|puede)\([^)]*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g,
  /permisos\.has\('([^']+)'\)/g,
  /scopes[^\n]*includes\('([^']+)'\)/g,
  // El mapa del MCP (`PERMISO_DE`) y las listas de herramientas: ahí el
  // permiso es el valor que después se exige.
  /^\s*[a-zA-Z_]+:\s*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)',?$/gm,
];

/** Repartir un permiso no es verificarlo. */
const NO_ES_VERIFICAR = ['domain/base-roles.ts'];

function verificados(): Set<string> {
  const usados = new Set<string>();
  const fuentes = [
    ...archivosTs(join(REPO, 'apps/api/src')),
    ...archivosTs(join(REPO, 'apps/workers/src')),
    ...archivosTs(join(REPO, 'apps/agents/src')),
    ...archivosTs(MODULOS).filter((f) => !f.includes('/tests/')),
  ].filter((f) => !NO_ES_VERIFICAR.some((excluido) => f.includes(excluido)));
  for (const archivo of fuentes) {
    const contenido = readFileSync(archivo, 'utf8');
    for (const patron of FORMAS_DE_VERIFICAR) {
      for (const m of contenido.matchAll(patron)) usados.add(m[1]);
    }
  }
  /**
   * Los manifiestos NO cuentan, y antes sí (#838).
   *
   * Esto recorría los `module.yaml` sumando cada `permission: <x>` —o sea cada
   * entrada de `nav` y cada `widget`— y cada nombre bajo `tools:`. Un permiso
   * que solo aparecía en el `nav` de su propio módulo quedaba marcado como
   * verificado **por el mismo archivo que lo declara**.
   *
   * Esta guarda existe para cazar un permiso del catálogo que ningún endpoint
   * exige: uno que el ADMIN le reparte a un rol creyendo que abre algo. Que la
   * declaración del propio manifiesto lo salve es exactamente la clase de
   * declaración inerte que vino a cazar — el mismo agujero que este archivo
   * documenta haber cerrado para `base-roles.ts` («repartir un permiso no es
   * verificarlo»), dejado abierto para los manifiestos.
   *
   * Medido antes de sacarlo: de los 70 del catálogo, **66 los verifica el
   * código** y los 4 que no están los cuatro en PENDIENTES. **Cero** se
   * salvaban por el manifiesto, así que esto no cambia nada hoy y cierra el
   * hueco de mañana: agregar una pantalla con un permiso nuevo y su entrada de
   * `nav`, sin un solo endpoint que lo exija, ahora entra en la lista.
   */
  return usados;
}

/**
 * Permisos que existen para una función TODAVÍA no construida. Cada uno con
 * su motivo y su issue: la lista distingue "falta hacerlo" de "se nos
 * olvidó", que es justo lo que no se podía distinguir.
 */
const PENDIENTES: Record<string, string> = {
  // Nota: las TOOLS de los agentes (`crm.find_contact`, `conversations.send_reply`…)
  // se declaran en el bloque `tools:` del manifiesto y no son permisos —
  // el registry las filtra por módulo activo. No van acá.
  'calendar.connect':
    'Conectar Google Calendar: necesita las credenciales de OAuth (#57). La agenda funciona sin él, con la disponibilidad configurada.',
  'tenant.billing': 'Ver y cambiar el plan desde la app; hoy lo hace el SuperAdmin (#69).',
  'whatsapp.numbers.manage':
    'Administrar números desde la app; hoy la conexión es por script (#42) y el resto usa channels.manage.',
  // `crm.contacts.update` y `crm.deals.close` estaban acá y YA SE EXIGEN:
  // el primero en contacts.controller.ts:330 y empresas.controller.ts:177, el
  // segundo en deals.controller.ts:234 (`puedeCerrar`). Los sacó la prueba
  // nueva de «cada pendiente sigue sin verificarse»: la lista decía «falta» de
  // dos cosas hechas, y la siguiente persona la habría leído como un mapa
  // viejo.
  'teams.manage':
    'Los equipos no están construidos (#540): la tabla `teams` existe con RLS y sin un solo endpoint, ' +
    'y `conversations.team_id` tampoco se escribe nunca. Llevaba meses declarado y REPARTIDO a ' +
    'SUPERVISOR y ADMIN sin que esta guarda lo notara, porque contaba la concesión de base-roles.ts ' +
    'como si fuera una verificación.',
};

describe('catálogo de permisos', () => {
  it('ninguna ruta exige un permiso que no exista', () => {
    const declarada = declarados();
    const enRutas = new Set<string>();
    for (const archivo of archivosTs(join(REPO, 'apps/api/src'))) {
      for (const m of readFileSync(archivo, 'utf8').matchAll(/@RequirePermission\('([^']+)'\)/g)) {
        enRutas.add(m[1]);
      }
    }
    expect(enRutas.size).toBeGreaterThan(30);
    const inventados = [...enRutas].filter((p) => !declarada.has(p));
    expect(
      inventados,
      `Estas rutas exigen permisos que no están en ningún module.yaml:\n  ${inventados.join('\n  ')}\n` +
        'Responderían 403 para siempre, incluso al dueño del negocio.',
    ).toEqual([]);
  });

  it('todo permiso declarado se verifica en alguna parte, o está en la lista de pendientes', () => {
    const declarada = declarados();
    const usada = verificados();
    expect(declarada.size).toBeGreaterThan(50);

    const huerfanos = [...declarada]
      .filter((p) => !usada.has(p))
      .filter((p) => !(p in PENDIENTES))
      .sort();

    expect(
      huerfanos,
      `Estos permisos existen en el catálogo y NADIE los verifica:\n  ${huerfanos.join('\n  ')}\n` +
        'Alguien se los va a dar a un rol creyendo que hacen algo. Úsalos, bórralos, ' +
        'o agrégalos a PENDIENTES con el motivo y el issue.',
    ).toEqual([]);
  });

  it('la lista de pendientes no menciona permisos que ya no existen', () => {
    const declarada = declarados();
    const fantasmas = Object.keys(PENDIENTES).filter((p) => !declarada.has(p));
    expect(fantasmas, `Pendientes que ya no están en ningún catálogo: ${fantasmas.join(', ')}`).toEqual([]);
  });

  it('repartir un permiso NO cuenta como verificarlo', () => {
    // Es la propiedad que faltaba y por la que esto pasaba engañado. Se fija con
    // un permiso que EXISTE, está repartido en base-roles.ts, y no lo exige
    // ninguna ruta: si `verificados()` volviera a leer ese archivo, este test
    // avisa antes de que la guarda entera vuelva a dar permiso.
    const usada = verificados();
    expect(
      usada.has('teams.manage'),
      'verificados() volvió a contar base-roles.ts: repartir no es verificar',
    ).toBe(false);
    // Y el archivo sigue repartiéndolo, o sea el caso sigue siendo el caso.
    const base = readFileSync(
      join(REPO, 'packages/modules/authorization/domain/base-roles.ts'),
      'utf8',
    );
    expect(base, 'si ya no se reparte, este test perdió su sujeto').toContain("'teams.manage'");
  });

  it('cada pendiente sigue declarado y sigue sin verificarse', () => {
    // Una lista de pendientes con entradas ya construidas dice «falta» de algo
    // que está hecho, y la siguiente persona la lee como un mapa viejo.
    const declarada = declarados();
    const usada = verificados();
    const yaNoAplican = Object.keys(PENDIENTES).filter((p) => !declarada.has(p) || usada.has(p));
    expect(
      yaNoAplican,
      'Sácalos de PENDIENTES: o ya no están declarados, o ya se verifican:\n  ' +
        yaNoAplican.join('\n  '),
    ).toEqual([]);
  });
});

/**
 * Y lo que la guarda NO tiene que aceptar como verificación (#838).
 *
 * `verificados()` recorría los `module.yaml` sumando cada `permission: <x>`
 * —cada entrada de `nav`, cada `widget`— y cada nombre bajo `tools:`. Un
 * permiso que solo aparecía en el `nav` de su propio módulo quedaba marcado
 * como verificado por el mismo archivo que lo declara.
 *
 * No hay centinela natural para probarlo con datos de hoy: medido, de los 70
 * del catálogo el código verifica 66 y los 4 que faltan están los cuatro en
 * PENDIENTES — **cero** se salvaban por el manifiesto. Así que la propiedad se
 * fija sobre la función: que no vuelva a abrir un `module.yaml`.
 *
 * Con los marcadores comprobados antes de recortar, que es la lección de
 * #823: un `indexOf` que devuelve -1 deja un bloque vacío y toda aserción
 * negativa pasa.
 */
describe('declarar un permiso no es verificarlo (#838)', () => {
  const ESTE = readFileSync(join(REPO, 'apps/api/tests/catalogo-permisos.test.ts'), 'utf8');

  it('verificados() no lee los manifiestos', () => {
    const desde = ESTE.indexOf('function verificados()');
    const hasta = ESTE.indexOf('const PENDIENTES', desde);
    expect(desde, 'no se encontró `function verificados()`').toBeGreaterThan(-1);
    expect(hasta, 'no se encontró `const PENDIENTES` después').toBeGreaterThan(desde);
    // LIMPIO, que es la regla de la casa (#569): el comentario que explica
    // por qué los manifiestos no cuentan los nombra, y sin esto la guarda se
    // pone roja por el texto que la explica. Pasó al escribirla.
    const cuerpo = fuenteLimpia(ESTE.slice(desde, hasta));
    expect(cuerpo.trim().length, 'el recorte quedó vacío').toBeGreaterThan(200);

    expect(
      cuerpo,
      'Volvió a contar los manifiestos como verificación. Un permiso declarado en el `nav` de ' +
        'su propio módulo, sin un endpoint que lo exija, abre una pantalla cuyas llamadas ' +
        'funcionan para todos — y el ADMIN lo reparte creyendo que abre algo.',
    ).not.toMatch(/module\.yaml/);
  });

  it('y sigue verificando por el código, que es la forma que vale', () => {
    // Anti-vacuidad del de arriba: si `verificados()` devolviera poco, la
    // guarda principal mandaría todo a PENDIENTES en vez de quedarse muda.
    const usada = verificados();
    expect(usada.size).toBeGreaterThan(60);
    expect(usada.has('audit.read')).toBe(true);
    expect(usada.has('crm.contacts.update')).toBe(true);
  });
});
