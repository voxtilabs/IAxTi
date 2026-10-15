import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';
import {
  crucesEntreModulos,
  crucesFueraDeLaRegla,
  duenosDeTabla,
  medicionDeCruces,
  nombreDelCruce,
  tablasQueConsulta,
} from '../src/consultas-entre-modulos';
import type { Cruce } from '../src/consultas-entre-modulos';

/**
 * La regla de consultas entre módulos, en vigor (#784).
 *
 * `.claude/rules/db.md` decía «consultas de otro módulo: prohibidas» y eso no
 * era la regla: cruzan 35 pares de módulos, 16 de ellos hacia algo que ya
 * declaran en `depends_on`. Una regla que la mayoría rompe es peor que no tener
 * regla —mientras esté escrita, cada PR elige entre romperla o pagar un
 * refactor que nadie pidió— así que lo escrito pasó a ser lo que de verdad
 * rige, en dos mitades: LEER lo que declarás se permite y se documenta en el
 * manifiesto; leer lo que no declarás, no; y ESCRIBIR en la tabla de otro, no,
 * lo declares o no — declarar es depender de un esquema, no poder escribirlo.
 *
 * Y una regla que se afloja sin guarda queda peor que antes, que es el riesgo
 * que nombró el issue. Esto es la guarda: las 22 entradas que quedaron fuera de
 * la regla nueva están en `docs/consultas-entre-modulos.txt` con su motivo y su
 * issue, y no pueden ser 23.
 */
const MODULOS = findModulesDir();
const RAIZ = join(__dirname, '..', '..', '..');
const LISTA = join(RAIZ, 'docs', 'consultas-entre-modulos.txt');

const modulos = loadAllManifests(MODULOS).map((m) => ({
  id: m.module.id,
  dir: join(MODULOS, m.module.id),
  // `required` y `optional` juntas: las dos documentan el cruce, que es para lo
  // que la regla mira el manifiesto. Cuál de las dos corresponde lo decide otra
  // pregunta —si el módulo degrada sin el otro— y la gobierna #821.
  declaradas: [...(m.depends_on?.required ?? []), ...(m.depends_on?.optional ?? [])],
}));

/**
 * El escaneo se hace UNA vez para todo el archivo.
 *
 * No es microoptimización: cuatro de estas pruebas necesitan el mismo barrido
 * del repo, y repetirlo multiplica por cuatro el único costo que tiene esta
 * guarda. Con la máquina cargada, los escáneres de este repo pasan de los 5 s
 * de vitest (#776) y el rojo que sale entonces no habla del cambio — y un rojo
 * que no habla del cambio enseña a ignorar el rojo.
 */
const duenos = duenosDeTabla(MODULOS);
const cruces = crucesEntreModulos(modulos, duenos);
const fueraDeLaRegla = crucesFueraDeLaRegla(cruces);
const medicion = medicionDeCruces(cruces);

/** Un cruce de mentira, para probar los filtros sin barrer el repo. */
const cruce = (parcial: Partial<Cruce>): Cruce => ({
  modulo: 'crm',
  dueno: 'conversations',
  declarado: false,
  escribe: false,
  tablas: ['conversations'],
  archivos: [],
  consultas: 1,
  escrituras: 0,
  ...parcial,
});

/** `modulo→dueno (marca: tablas) — motivo Arreglo: #n.` por línea. */
const base = readFileSync(LISTA, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'))
  .map((l) => {
    const [par, ...resto] = l.split(' — ');
    return { par: par.trim(), motivo: resto.join(' — ').trim() };
  });

describe('el escáner distingue leer de escribir (#784)', () => {
  it('un FROM y un JOIN son lectura', () => {
    expect(
      tablasQueConsulta("const q = `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id`;"),
    ).toEqual([
      { tabla: 'conversations', escribe: false },
      { tabla: 'messages', escribe: false },
    ]);
  });

  it('un DELETE FROM es ESCRITURA, no la lectura que su FROM parece', () => {
    // La trampa de esta guarda: `DELETE FROM` contiene la palabra `FROM`, así
    // que es el caso que se clasifica mal solo —un escáner que mire «empieza
    // con INSERT o UPDATE» lo deja como lectura—. Y la distinción es justo la
    // que tiene consecuencia real: un borrado en la tabla de otro rompe sus
    // invariantes sin pasar por su código. `titular.ts` borra los mensajes del
    // titular exactamente así.
    expect(tablasQueConsulta("'DELETE FROM messages WHERE tenant_id = $1'")).toEqual([
      { tabla: 'messages', escribe: true },
    ]);
  });

  it('un INSERT INTO y un UPDATE, también', () => {
    expect(
      tablasQueConsulta("`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`"),
    ).toEqual([{ tabla: 'user_roles', escribe: true }]);
    expect(tablasQueConsulta("`UPDATE messages SET type = 'plantilla' WHERE id = $2`")).toEqual([
      { tabla: 'messages', escribe: true },
    ]);
  });

  it('la tabla que se lee Y se escribe queda marcada como escritura', () => {
    // El par es la unidad: si alguna de sus consultas escribe, el par escribe.
    // Lo contrario dejaría que un `UPDATE` se esconda detrás de los diez
    // `SELECT` del mismo archivo.
    expect(
      tablasQueConsulta(
        "const a = 'SELECT id FROM conversations WHERE tenant_id = $1';" +
          "const b = 'UPDATE conversations SET summary = NULL WHERE id = $2';",
      ),
    ).toEqual([{ tabla: 'conversations', escribe: true }]);
  });

  it('un comentario que nombra la tabla NO cuenta como consulta', () => {
    // Los comentarios de este repo nombran tablas todo el tiempo —explican por
    // qué algo cruza, justamente— y ya pusieron en rojo a cuatro guardas
    // distintas (#569). Una guarda que grita de más se apaga igual de rápido
    // que una que no grita.
    expect(
      tablasQueConsulta(
        '// SELECT * FROM messages: esto lo hacía antes y se cambió por contrato\n' +
          '/* UPDATE conversations SET summary = NULL */\n',
      ),
    ).toEqual([]);
  });

  it('un fragmento de consulta sin verbo se mira igual', () => {
    // Este repo parte consultas largas en varias cadenas, y el pedazo que trae
    // el JOIN puede no traer ningún SELECT. Mirar solo los verbos dejaba afuera
    // justo el pedazo donde vive la tabla ajena.
    expect(tablasQueConsulta("const sql = base + ' JOIN tenants t ON t.id = ur.tenant_id';")).toEqual(
      [{ tabla: 'tenants', escribe: false }],
    );
  });

  it('el SQL entre comillas DOBLES se mira igual que el de comillas simples', () => {
    // El repo ya tiene SQL entre comillas dobles —`conversations.ts:573`, que
    // lo escribe así porque la consulta lleva adentro un `'out'`— y nada fija
    // las comillas: no hay formateador configurado ni regla de lint. Ésa no
    // cruza, pero la próxima podía, y el modo de falla era el peor: la guarda
    // no se ponía roja, se quedaba corta.
    expect(tablasQueConsulta('const q = "SELECT id FROM messages WHERE tenant_id = $1";')).toEqual([
      { tabla: 'messages', escribe: false },
    ]);
    expect(tablasQueConsulta('await c.query("DELETE FROM webchat_sessions");')).toEqual([
      { tabla: 'webchat_sessions', escribe: true },
    ]);
  });

  it('el identificador entre comillas dobles no parte la plantilla que lo contiene', () => {
    // El riesgo de leer comillas dobles: `FROM "messages"` dentro de un
    // backtick. Si la comilla del identificador abriera una cadena, la
    // plantilla se leería partida y el JOIN de después se perdería — que es el
    // mismo agujero que se venía a tapar.
    expect(
      tablasQueConsulta(
        'const q = `SELECT * FROM "messages" m JOIN "conversations" c ON c.id = m.conversation_id`;',
      ),
    ).toEqual([
      { tabla: 'conversations', escribe: false },
      { tabla: 'messages', escribe: false },
    ]);
  });

  it('el nombre de la entrada lleva el par, la marca Y las tablas', () => {
    // Es la llave de la lista base: si este formato cambia, las 22 entradas del
    // .txt dejan de calzar y el trinquete manda a reescribirlas todas. Queda
    // fijado acá para que ese cambio sea una decisión y no un descuido.
    expect(
      nombreDelCruce(cruce({ escribe: true, tablas: ['conversations', 'messages'] })),
    ).toBe('crm→conversations (escribe: conversations, messages)');
  });

  it('ampliar un cruce a una tabla más CAMBIA la llave de la entrada', () => {
    // El agujero que esto tapa: con la llave en el par solo, una entrada ya
    // concedida absorbía crecimiento sin límite —`platform→agents (lee)` cubría
    // tres tablas y treinta mañana sin que la marca se moviera—. Lo concedido
    // fue el alcance medido el día que se concedió; ampliarlo es una decisión.
    const tres = nombreDelCruce(cruce({ tablas: ['agent_executions', 'agents', 'eval_runs'] }));
    const cuatro = nombreDelCruce(
      cruce({ tablas: ['agent_executions', 'agents', 'eval_runs', 'agent_proposals'] }),
    );
    expect(cuatro).not.toBe(tres);
  });

  it('lo que NO ve, escrito: el nombre de la tabla interpolado', () => {
    // `retention.ts` borra de las tablas de otros módulos con `${tabla}` en un
    // bucle, y el escáner no lo ve. Queda acá como prueba y no como comentario
    // para que el día que alguien enseñe a leer eso, esta prueba falle y lo
    // mande a bajar la marca de la lista base en vez de dejar el hueco abierto.
    expect(tablasQueConsulta('await c.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`);')).toEqual(
      [],
    );
  });
});

describe('cada tabla tiene un módulo dueño (#784)', () => {
  it('el escáner encuentra el esquema (si esto falla, se rompió el escáner)', () => {
    expect(duenos.size).toBeGreaterThan(60);
    expect(duenos.get('messages')).toBe('conversations');
    expect(duenos.get('contacts')).toBe('crm');
    expect(duenos.get('user_roles')).toBe('authorization');
  });

  it('`tenants` es de organizations, aunque packages/db también la cree', () => {
    // `packages/db/migrations/0000_tenants.sql` la crea con IF NOT EXISTS para
    // arrancar la base, y `organizations/migrations/0001_tenants.sql` la crea
    // igual. El dueño es el módulo: leer `tenants` ES cruzar hacia
    // `organizations`, y por eso `identity→organizations` está en la lista.
    expect(duenos.get('tenants')).toBe('organizations');
  });

  it('la infraestructura no tiene dueño: el outbox no es un cruce', () => {
    // `outbox`, `processed_events` e `idempotency_keys` viven en packages/db y
    // no son de ningún módulo. Si tuvieran dueño, CADA módulo que publica un
    // evento aparecería cruzando hacia él, y una lista con diecinueve entradas
    // de ruido enseña a no mirar la lista.
    expect(duenos.has('outbox')).toBe(false);
    expect(duenos.has('processed_events')).toBe(false);
    expect(duenos.has('idempotency_keys')).toBe(false);
  });
});

describe('las dos mitades de la regla (#784)', () => {
  it('leer lo que NO se declara entra en la lista', () => {
    expect(crucesFueraDeLaRegla([cruce({ declarado: false, escribe: false })])).toEqual([
      'crm→conversations (lee: conversations)',
    ]);
  });

  it('leer lo que SÍ se declara no entra: listar lo permitido es una lista que nadie revisa', () => {
    expect(crucesFueraDeLaRegla([cruce({ declarado: true, escribe: false })])).toEqual([]);
  });

  it('ESCRIBIR entra aunque el módulo esté declarado', () => {
    // La mitad que la primera versión de la guarda no tenía, y por eso las tres
    // escrituras hacia `organizations` —billing, conversations y platform—
    // pasaban sin que nadie las mirara. Declarar documenta una dependencia de
    // esquema; no reparte permiso sobre las invariantes del otro. Si esto
    // volviera a pasar de largo, la guarda diría una regla y `db.md` otra, y la
    // que gana es la guarda, porque es la que se pone roja.
    expect(
      crucesFueraDeLaRegla([
        cruce({ modulo: 'billing', dueno: 'organizations', declarado: true, escribe: true, tablas: ['tenants'] }),
      ]),
    ).toEqual(['billing→organizations (escribe: tenants)']);
  });
});

describe('la medición del criterio 2: cuántas de las que cruzan son escrituras (#784)', () => {
  it('cuenta pares y consultas archivo-tabla, partidos por lectura y escritura', () => {
    expect(
      medicionDeCruces([
        cruce({ declarado: true, escribe: false, consultas: 5, escrituras: 0 }),
        cruce({ modulo: 'crm', dueno: 'agents', escribe: true, consultas: 3, escrituras: 2 }),
      ]),
    ).toEqual({
      pares: 2,
      paresQueEscriben: 1,
      paresDeclarados: 1,
      consultas: 8,
      escrituras: 2,
    });
  });

  it('sobre el repo de verdad: hay escrituras, y son la minoría', () => {
    // El número que el issue pedía antes de elegir qué regla escribir. Las dos
    // aserciones tienen que ser estrictas: si el escáner marcara TODO como
    // escritura —o nada— la regla partida en dos mitades dejaría de tener
    // sentido y esto es lo que lo diría.
    expect(medicion.escrituras).toBeGreaterThan(0);
    expect(medicion.escrituras).toBeLessThan(medicion.consultas / 2);
    // Y el par agrega archivos: si `consultas` no sumara, los dos serían iguales
    // y la medición no estaría diciendo nada que la lista no dijera ya.
    expect(medicion.consultas).toBeGreaterThan(medicion.pares);
    expect(medicion.paresQueEscriben).toBeGreaterThan(0);
    expect(medicion.paresQueEscriben).toBeLessThan(medicion.pares);
  });
});

describe('la lista base de cruces fuera de la regla (#784)', () => {
  it('la guarda está mirando algo: hay módulos, hay cruces y hay declarados', () => {
    // Anti-vacuidad. Si el escáner devolviera nada —un `archivosFuente` que no
    // baja, un `duenosDeTabla` vacío— las aserciones de abajo quedarían verdes
    // sobre listas vacías, y una aserción negativa sobre lo que no está pasa
    // sola.
    expect(modulos.length).toBeGreaterThan(15);
    expect(cruces.length).toBeGreaterThan(25);
    expect(cruces.filter((c) => c.declarado).length).toBeGreaterThan(10);
  });

  it('cada entrada dice si lee o si escribe, y QUÉ TABLAS', () => {
    // Las dos cosas van en el nombre a propósito: un par que hoy lee y mañana
    // escribe entra como entrada NUEVA, y uno que hoy toca tres tablas y
    // mañana treinta, también.
    const malFormadas = base.filter((e) => !/ \((lee|escribe): [a-z_]+(, [a-z_]+)*\)$/.test(e.par));
    expect(malFormadas.map((e) => e.par)).toEqual([]);
  });

  it('cada entrada apunta al issue que la levanta (criterio 4 del #784)', () => {
    // #784 midió y no arregló a propósito: cada par necesita que alguien mire
    // si ese módulo de verdad degrada sin el otro, y eso es un PR por par. El
    // criterio de aceptación pedía que lo que queda prohibido tenga su issue,
    // y sin esta aserción «su issue» es una promesa de la descripción del PR.
    // No alcanza con que el motivo nombre UN issue: casi todos citan el que
    // originó el código (#66, #69, #81). Lo que se exige es el del ARREGLO.
    const sinIssue = base.filter((e) => !/Arreglo: #\d+\.$/.test(e.motivo));
    expect(
      sinIssue.map((e) => e.par),
      'Estas entradas no dicen qué issue las levanta. Abrí uno con lo que haría falta para ' +
        'que el cruce deje de existir y terminá el motivo con «Arreglo: #NNN.»:\n  ' +
        sinIssue.map((e) => e.par).join('\n  '),
    ).toEqual([]);
  });

  it('la lista está ordenada y sin repetidas: si no, el diff no se lee', () => {
    const pares = base.map((e) => e.par);
    expect(pares).toEqual([...pares].sort((a, b) => a.localeCompare(b)));
    expect(new Set(pares).size).toBe(pares.length);
  });

  it('cada entrada explica POR QUÉ cruza, no solo que cruza', () => {
    // Tener que escribir el porqué es lo que impide que la lista crezca sola.
    // Un motivo que apunta al trabajo que falta está bien; uno vacío no.
    const sinMotivo = base.filter(
      (e) => e.motivo.length < 40 || e.motivo.startsWith('SIN MOTIVO'),
    );
    expect(
      sinMotivo.map((e) => e.par),
      'Escribe por qué este cruce no pasa por el manifiesto:\n  ' +
        sinMotivo.map((e) => e.par).join('\n  '),
    ).toEqual([]);
  });

  it('ningún módulo consulta tablas de otro que no declara', () => {
    const nuevos = fueraDeLaRegla.filter((c) => !base.some((e) => e.par === c));
    expect(
      nuevos,
      'Este módulo consulta tablas de otro que no declara en `depends_on`. Declaralo en su ' +
        'module.yaml —`optional` si degrada sin él— o pedile los datos por contrato o por ' +
        'evento. Si de verdad no hay otra, agregalo a docs/consultas-entre-modulos.txt CON SU ' +
        'MOTIVO (node scripts/consultas-entre-modulos.mjs --detalle dice qué tablas y qué ' +
        'archivos son):\n  ' + nuevos.join('\n  '),
    ).toEqual([]);
  });

  it('y si alguno dejó de cruzar, la marca BAJA', () => {
    const resueltos = base.filter((e) => !fueraDeLaRegla.includes(e.par)).map((e) => e.par);
    expect(
      resueltos,
      'Estos ya no cruzan sin declarar —o lo declararon, o dejaron de escribir—: la marca ' +
        'tiene que bajar. Corre\n' +
        '  node scripts/consultas-entre-modulos.mjs --escribir\n' +
        'Sin esto el trinquete se afloja solo, y una deuda que no se ve bajar nunca baja:\n  ' +
        resueltos.join('\n  '),
    ).toEqual([]);
  });
});
