import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';
import {
  crucesEntreModulos,
  crucesSinDeclarar,
  duenosDeTabla,
  nombreDelCruce,
  tablasQueConsulta,
} from '../src/consultas-entre-modulos';

/**
 * La regla de consultas entre módulos, en vigor (#784).
 *
 * `.claude/rules/db.md` decía «consultas de otro módulo: prohibidas» y eso no
 * era la regla: cruzan 35 pares de módulos, 16 de ellos hacia algo que ya
 * declaran en `depends_on`. Una regla que la mayoría rompe es peor que no tener
 * regla —mientras esté escrita, cada PR elige entre romperla o pagar un
 * refactor que nadie pidió— así que lo escrito pasó a ser lo que de verdad
 * rige: cruzar hacia lo que declarás se permite y se documenta ahí; hacia lo
 * que no declarás, no.
 *
 * Y una regla que se afloja sin guarda queda peor que antes, que es el riesgo
 * que nombró el issue. Esto es la guarda: los 19 pares que quedaron fuera de la
 * regla nueva están en `docs/consultas-entre-modulos.txt` con su motivo, y no
 * pueden ser 20.
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
const sinDeclarar = crucesSinDeclarar(cruces);

/** `modulo→dueno (marca) — motivo` por línea. */
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

  it('el nombre de la entrada lleva el par Y la marca', () => {
    // Es la llave de la lista base: si este formato cambia, las 19 entradas del
    // .txt dejan de calzar y el trinquete manda a reescribirlas todas. Queda
    // fijado acá para que ese cambio sea una decisión y no un descuido.
    expect(
      nombreDelCruce({
        modulo: 'crm',
        dueno: 'conversations',
        declarado: false,
        escribe: true,
        tablas: ['conversations', 'messages'],
        archivos: [],
      }),
    ).toBe('crm→conversations (escribe)');
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

describe('la lista base de cruces sin declarar (#784)', () => {
  it('la guarda está mirando algo: hay módulos, hay cruces y hay declarados', () => {
    // Anti-vacuidad. Si el escáner devolviera nada —un `archivosFuente` que no
    // baja, un `duenosDeTabla` vacío— las aserciones de abajo quedarían verdes
    // sobre listas vacías, y una aserción negativa sobre lo que no está pasa
    // sola.
    expect(modulos.length).toBeGreaterThan(15);
    expect(cruces.length).toBeGreaterThan(25);
    expect(cruces.filter((c) => c.declarado).length).toBeGreaterThan(10);
  });

  it('cada entrada dice si lee o si escribe', () => {
    // La marca va en el nombre a propósito: un par que hoy lee y mañana
    // escribe entra como par NUEVO y hay que justificarlo.
    const sinMarca = base.filter((e) => !/ \((lee|escribe)\)$/.test(e.par));
    expect(sinMarca.map((e) => e.par)).toEqual([]);
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
    const nuevos = sinDeclarar.filter((c) => !base.some((e) => e.par === c));
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
    const resueltos = base.filter((e) => !sinDeclarar.includes(e.par)).map((e) => e.par);
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
