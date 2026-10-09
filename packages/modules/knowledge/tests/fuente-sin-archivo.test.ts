import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addSource, eliminarFuente, listSources } from '../application/sources';
import { getProduct, searchKnowledge } from '../application/search';
import type { EmbedPort } from '../application/embeddings';
import { DIMENSIONES } from '../application/embeddings';

/**
 * Fuente viva, archivo destruido (#631).
 *
 * `deleteSource` borra el archivo de R2 DENTRO de la transacción y lanza si el
 * bucket falla, para que la fila vuelva y la persona pueda reintentar (#630).
 * Esa decisión es la correcta: la falla inversa —fila borrada y archivo todavía
 * bajable con una URL firmada— es una fuga que nadie puede ver.
 *
 * Pero deja un hueco: si el borrado en R2 sale BIEN y el COMMIT falla después,
 * la fila vuelve **sin su archivo**. Y era justo el estado que el chequeo de
 * frescura del cache (#621) no podía ver —pregunta si la fuente existe y está
 * vigente, y la respuesta era sí—, así que el copiloto seguía citando un PDF que
 * nadie puede bajar, con la bendición explícita del chequeo. Quien siguiera la
 * cita se quedaba esperando un archivo que no está.
 *
 * Lo encontró el verificador mirando los dos diffs juntos: ninguna de las dos
 * pruebas lo veía, porque cada una miraba su mitad.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

const embedFalso: EmbedPort = {
  async embed(textos) {
    return textos.map(() => Array.from({ length: DIMENSIONES }, (_, i) => (i === 0 ? 1 : 0)));
  },
};

/** Un bucket que borra de verdad, o que falla. */
function bucketFalso(modo: 'borra' | 'falla' = 'borra') {
  const pedidas: string[] = [];
  return {
    pedidas,
    almacen: {
      async borrar(keys: string[]) {
        pedidas.push(...keys);
        return modo === 'borra'
          ? { borradas: [...keys], fallidas: [] }
          : { borradas: [], fallidas: [...keys] };
      },
    },
  };
}

/**
 * Un pool cuyo COMMIT falla.
 *
 * Es la única forma honesta de probar este hueco: el momento que importa está
 * justo DESPUÉS de que el archivo se destruyó y justo ANTES de que la fila
 * quede borrada, y desde adentro de la transacción ese momento no se ve. Todo
 * lo demás del cliente es el real — la transacción abre, borra y después se
 * deshace de verdad.
 *
 * Falla `veces` commits y después deja pasar, que es lo que pasa de verdad: un
 * hipo de la base, un `pg_terminate_backend`, un failover. Si fallara SIEMPRE,
 * la marca —que viaja por otra conexión del mismo pool— tampoco podría
 * escribirse y la prueba estaría midiendo una base muerta, no este hueco.
 */
function poolQueNoConfirma(real: Pool, veces = 1): Pool {
  let restantes = veces;
  return {
    async connect() {
      const client = await real.connect();
      return new Proxy(client, {
        get(destino, prop) {
          if (prop !== 'query') return Reflect.get(destino, prop);
          return (...args: unknown[]) => {
            if (args[0] === 'COMMIT' && restantes > 0) {
              restantes -= 1;
              return Promise.reject(new Error('se cayó la base justo al confirmar'));
            }
            return (destino.query as (...a: unknown[]) => unknown)(...args);
          };
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('sin-archivo-631') RETURNING id"))
    .rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM chunks WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM products WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM sources WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  // El tenant y su `audit_log` se quedan: el libro es append-only —un trigger
  // rechaza el DELETE— y por la FK el tenant tampoco se puede sacar. Es la
  // regla funcionando, no un olvido: la evidencia de que esto pasó sobrevive
  // incluso a la prueba que lo provocó.
  await admin.end();
});

const fuentePdf = (nombre: string) =>
  withTenant(admin, tenant, (c) =>
    addSource(c, {
      tenantId: tenant,
      kind: 'pdf',
      name: nombre,
      r2Key: `${tenant}/conocimiento/${nombre}.pdf`,
      actor: 'test',
    }),
  );

const estadoDe = async (id: string) =>
  (await admin.query('SELECT status, error FROM sources WHERE id = $1', [id])).rows[0];

describe('el archivo se destruyó y la transacción se deshizo (#631)', () => {
  it('la fila vuelve MARCADA, no como si nada hubiera pasado', async () => {
    const bucket = bucketFalso();
    const f = await fuentePdf('contrato-marco');

    await expect(
      eliminarFuente(poolQueNoConfirma(admin), {
        tenantId: tenant,
        sourceId: f.id,
        actor: 'test',
        almacen: bucket.almacen,
      }),
    ).rejects.toThrow(/al confirmar/);

    // El archivo sí se fue: eso es lo que hace al estado peligroso.
    expect(bucket.pedidas).toHaveLength(1);

    const fila = await estadoDe(f.id);
    expect(fila.status, 'la fuente volvió viva y sin marcar').toBe('delete_failed');
    // Y el motivo, escrito para quien lo va a leer en la pantalla: con qué
    // acción se sale de este estado. «Falló» a secas manda a reintentar la
    // indexación, que acá no arregla nada.
    expect(fila.error).toMatch(/vuelve a subir el documento/i);
  });

  it('la marca viaja por una conexión aparte: la que rolleó ya no sirve', async () => {
    // Si se intentara escribir con el cliente de la transacción deshecha, esta
    // prueba vería la fila en 'processing' —como la dejó `addSource`— porque
    // ese `UPDATE` no se habría aplicado nunca.
    const f = await fuentePdf('tabla-de-comisiones');
    await expect(
      eliminarFuente(poolQueNoConfirma(admin), {
        tenantId: tenant,
        sourceId: f.id,
        actor: 'test',
        almacen: bucketFalso().almacen,
      }),
    ).rejects.toThrow();
    expect((await estadoDe(f.id)).status).not.toBe('processing');

    // Y queda en el libro: un estado al que se llega por una falla tiene que
    // poder explicarse después.
    const rastro = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1 AND resource_id = $2 AND action = 'knowledge.source.sin_archivo'`,
      [tenant, f.id],
    );
    expect(rastro.rows[0].n).toBe(1);
  });

  it('si la marca tampoco se puede escribir, el error que se propaga es el ORIGINAL', async () => {
    // La base sigue caída: ni la transacción ni la marca pueden confirmar. Lo
    // que no puede pasar es que el mensaje se convierta en «no pude marcar la
    // fuente»: eso le cambia el problema a quien lo lee, y el problema es que
    // la base se cayó. La fila queda sin marcar, y ese riesgo residual está
    // escrito en `eliminarFuente` y en el issue, no tapado acá.
    const f = await fuentePdf('base-caida');
    await expect(
      eliminarFuente(poolQueNoConfirma(admin, 99), {
        tenantId: tenant,
        sourceId: f.id,
        actor: 'test',
        almacen: bucketFalso().almacen,
      }),
    ).rejects.toThrow(/al confirmar/);
    expect((await estadoDe(f.id)).status).toBe('processing');
  });

  it('si el bucket FALLA, la fuente no se marca: su archivo sigue ahí', async () => {
    // La distinción que importa. El archivo intacto y la fuente viva es el
    // estado NORMAL después de un borrado que no se pudo hacer: marcarla «sin
    // su archivo» mandaría a subir de nuevo un documento que no se perdió.
    const f = await fuentePdf('lista-vieja');
    await expect(
      eliminarFuente(admin, {
        tenantId: tenant,
        sourceId: f.id,
        actor: 'test',
        almacen: bucketFalso('falla').almacen,
      }),
    ).rejects.toThrow(/no pudimos borrar el archivo/i);
    expect((await estadoDe(f.id)).status).toBe('processing');
  });

  it('terminar de borrar sí funciona: el archivo ya no está y el borrado completa', async () => {
    const f = await fuentePdf('para-terminar');
    await expect(
      eliminarFuente(poolQueNoConfirma(admin), {
        tenantId: tenant,
        sourceId: f.id,
        actor: 'test',
        almacen: bucketFalso().almacen,
      }),
    ).rejects.toThrow();
    expect((await estadoDe(f.id)).status).toBe('delete_failed');

    // Borrar en R2 es idempotente, así que la segunda pasada completa.
    await eliminarFuente(admin, {
      tenantId: tenant,
      sourceId: f.id,
      actor: 'test',
      almacen: bucketFalso().almacen,
    });
    const fuentes = await withTenant(admin, tenant, (c) => listSources(c, tenant));
    expect(fuentes.find((x) => x.id === f.id)).toBeUndefined();
  });
});

describe('una fuente sin su archivo no se cita (#631)', () => {
  /** Una fuente ACTIVA con pasaje, producto y un cache calentito. */
  async function fuenteCompleta(nombre: string): Promise<string> {
    const f = await withTenant(admin, tenant, (c) =>
      addSource(c, {
        tenantId: tenant,
        kind: 'pdf',
        name: nombre,
        r2Key: `${tenant}/conocimiento/${nombre}.pdf`,
        actor: 'test',
      }),
    );
    const [vector] = await embedFalso.embed(['La manicure cuesta 15.000 pesos.'], 'pasaje');
    await admin.query(
      `INSERT INTO chunks (tenant_id, source_id, content, embedding)
       VALUES ($1, $2, 'La manicure cuesta 15.000 pesos.', $3::halfvec)`,
      [tenant, f.id, `[${vector.join(',')}]`],
    );
    await admin.query(
      `INSERT INTO products (tenant_id, source_id, name, price, stock)
       VALUES ($1, $2, 'Manicure', 15000, 5)`,
      [tenant, f.id],
    );
    await admin.query("UPDATE sources SET status = 'active' WHERE id = $1", [f.id]);
    return f.id;
  }

  it('la búsqueda, el catálogo y el cache dejan de devolverla', async () => {
    const id = await fuenteCompleta('precios-vigentes');
    const pregunta = `¿cuánto cuesta la manicure? ${id}`;

    // Antes: la cita existe y el cache queda cargado con ella.
    const antes = await withTenant(admin, tenant, (c) =>
      searchKnowledge(c, { tenantId: tenant, query: pregunta }, embedFalso),
    );
    expect(antes.hits.some((h) => h.sourceId === id)).toBe(true);
    expect(
      (await withTenant(admin, tenant, (c) => getProduct(c, tenant, 'manicure'))).length,
    ).toBeGreaterThan(0);

    // El estado se pone a mano: así llega la base cuando el COMMIT se cayó.
    await admin.query("UPDATE sources SET status = 'delete_failed' WHERE id = $1", [id]);

    const despues = await withTenant(admin, tenant, (c) =>
      searchKnowledge(c, { tenantId: tenant, query: pregunta }, embedFalso),
    );
    expect(despues.hits.some((h) => h.sourceId === id), 'citó un archivo que no está').toBe(false);
    // Y NO vino del cache: ésa era la trampa — el chequeo de frescura decía
    // «sigue vigente» y servía la cita guardada sin volver a mirar.
    expect(despues.cached).toBe(false);
    expect(await withTenant(admin, tenant, (c) => getProduct(c, tenant, 'manicure'))).toEqual([]);
  });
});
