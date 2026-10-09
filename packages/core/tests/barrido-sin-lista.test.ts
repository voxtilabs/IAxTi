import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { barridosDelRepo, llamadasDeBarrido } from '../src/barridos-sin-lista';

/**
 * Un barrido que recorre todos los tenants no entra en silencio (#743).
 *
 * **Seis** barridos tenían el mismo defecto y se descubrieron de a uno, cada vez
 * por un test rojo: facturación (#580), recordatorios y reglas (#733), muestras
 * (#738), secuencias (#740), y las plantillas y los webhooks de este PR. Todos
 * llamaban a `porCadaTenant` / `idsDeTenants` sin lista.
 *
 * Medido el 09/10 con 1.283 tenants: **4,5 ms** por tenant sin trabajo, **~5,8 s**
 * cada barrido. Proyectado a mil tenants con la base a 64 ms de distancia (#711):
 * minutos de un cron haciendo nada, por barrido.
 *
 * Lo que hace que esto necesite una guarda y no seis arreglos: **el síntoma
 * depende del tamaño de la base de desarrollo**. `sweepSequences` no salió en
 * #733 porque esa noche la base tenía menos tenants y su prueba entraba justo
 * dentro del límite de vitest; el defecto llevaba meses y lo que cambió fue
 * cuántos tenants habían acumulado las suites. Y el de webhooks nunca salió
 * rojo, porque su prueba ya tenía presupuesto declarado (#728): el costo estaba
 * ahí, tapado por el arreglo del síntoma.
 *
 * Un barrido nuevo escrito mañana pasaría verde. Esto lo caza.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const FUENTES = [join(RAIZ, 'packages'), join(RAIZ, 'apps')];

/**
 * Los que pueden recorrer a todos, con su motivo.
 *
 * Tener que escribir el porqué es lo que impide que la lista crezca sola — el
 * mismo criterio de #703. Un motivo que dice «es rápido» no es un motivo: lo que
 * hay que explicar es por qué la condición de «tiene trabajo» no se puede saber
 * antes de entrar.
 */
const PUEDEN_RECORRER_A_TODOS: Record<string, string> = {};

describe('el escáner distingue una llamada con lista de una sin ella', () => {
  it('sin opciones, es sin lista', () => {
    const r = llamadasDeBarrido([
      { archivo: 'x.ts', codigo: 'await porCadaTenant(pool, async (c, t) => hacer(c, t));' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].conLista).toBe(false);
  });

  it('con `{ ids }` al final, es con lista', () => {
    const r = llamadasDeBarrido([
      { archivo: 'x.ts', codigo: 'await porCadaTenant(pool, async (c, t) => hacer(c, t), { ids });' },
    ]);
    expect(r[0].conLista).toBe(true);
  });

  it('con `{ ids: algo }` también', () => {
    const r = llamadasDeBarrido([
      { archivo: 'x.ts', codigo: 'await porCadaTenant(pool, fn, { ids: conTrabajo });' },
    ]);
    expect(r[0].conLista).toBe(true);
  });

  it('un callback LARGO con paréntesis adentro no confunde el recorte', () => {
    // Ésta es la que importa del escáner. El callback de `sweepBilling` son
    // ciento ochenta líneas y la lista va al FINAL, después de él: cortar en el
    // primer `)` —o a los N caracteres— daba esa llamada por culpable. Lo vi al
    // correr el escáner la primera vez.
    const relleno = Array.from(
      { length: 200 },
      (_, i) => `      await client.query('SELECT ${i} FROM algo WHERE x = $1', [t]);`,
    ).join('\n');
    const r = llamadasDeBarrido([
      {
        archivo: 'x.ts',
        codigo: `await porCadaTenant(pool, async (client, t) => {\n${relleno}\n  }, { ids: conTrabajo });`,
      },
    ]);
    expect(r[0].conLista, 'la lista va después del callback, no antes').toBe(true);
  });

  it('`estados` sin `ids` NO cuenta como lista: filtra por estado, no por trabajo', () => {
    const r = llamadasDeBarrido([
      { archivo: 'x.ts', codigo: "await porCadaTenant(pool, fn, { estados: ['active'] });" },
    ]);
    expect(r[0].conLista).toBe(false);
  });

  it('un comentario que menciona `ids` no la salva', () => {
    // Los comentarios de este repo nombran lo que buscan las guardas todo el
    // tiempo, y ya pusieron en verde a cuatro distintas.
    const r = llamadasDeBarrido([
      { archivo: 'x.ts', codigo: '// pasa ids algún día\nawait porCadaTenant(pool, fn);' },
    ]);
    expect(r[0].conLista).toBe(false);
  });

  it('encuentra las dos funciones, no solo una', () => {
    const r = llamadasDeBarrido([
      { archivo: 'x.ts', codigo: 'const a = await idsDeTenants(pool);\nawait porCadaTenant(pool, fn);' },
    ]);
    expect(r.map((x) => x.funcion).sort()).toEqual(['idsDeTenants', 'porCadaTenant']);
  });
});

describe('los barridos del repo (#743)', () => {
  it('el escáner encuentra algo (si esto falla, se rompió el escáner)', () => {
    const todos = barridosDelRepo(FUENTES);
    expect(todos.length, 'tiene que haber barridos que encontrar').toBeGreaterThanOrEqual(3);
    // Y no mira `packages/db`, que es donde VIVEN las dos funciones: pedirle
    // que se pase una lista a sí mismo no significa nada.
    expect(todos.every((l) => !l.archivo.includes('packages/db/src'))).toBe(true);
  });

  it('ningún barrido recorre a todos los tenants sin decir por qué', () => {
    const sinLista = barridosDelRepo(FUENTES)
      .filter((l) => !l.conLista)
      .map((l) => `${l.archivo.replace(`${RAIZ}/`, '')} (${l.funcion})`)
      .filter((clave) => !(clave in PUEDEN_RECORRER_A_TODOS));
    expect(
      sinLista,
      'Estos barridos visitan TODOS los tenants: una transacción por cada uno, ' +
        'tengan trabajo o no. Medido: 4,5 ms por tenant sin trabajo, y con la base ' +
        'lejos son minutos de un cron haciendo nada.\n' +
        'Pásales `{ ids }` con quién tiene trabajo —la forma está en ADR-0026— o ' +
        'agrégalos a PUEDEN_RECORRER_A_TODOS explicando por qué la condición no se ' +
        'puede saber antes de entrar:\n' +
        sinLista.map((s) => `  ${s}`).join('\n'),
    ).toEqual([]);
  });

  it('cada excepción explica POR QUÉ, y sigue existiendo', () => {
    const todos = barridosDelRepo(FUENTES).map(
      (l) => `${l.archivo.replace(`${RAIZ}/`, '')} (${l.funcion})`,
    );
    for (const [clave, motivo] of Object.entries(PUEDEN_RECORRER_A_TODOS)) {
      expect(motivo.length, `${clave}: el motivo está vacío`).toBeGreaterThan(20);
      expect(todos, `${clave} ya no existe: saca la excepción`).toContain(clave);
    }
  });
});
