import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addSource, eliminarFuente } from '../application/sources';
import { reconciliarBorradosPendientes } from '../application/borrados-pendientes';

/**
 * La ventana invisible (#751).
 *
 * #631 cubre el COMMIT que falla: `eliminarFuente` se entera desde afuera y
 * marca la fuente. Lo que no cubre es que el PROCESO MUERA en el medio — OOM,
 * deploy, el contenedor que se va. Ahí no hay nadie afuera: el archivo se
 * destruyó, el rollback devolvió la fila viva, y nadie marcó nada. La fuente
 * se sigue citando y el PDF no se puede bajar.
 *
 * Estas pruebas arman ese estado de verdad —archivo borrado del bucket, fila
 * viva, sin marca— y le piden al barrido que lo encuentre. La que más importa
 * es la última: el barrido NO BORRA ARCHIVOS. Un barrido que borrara, con una
 * condición mal escrita, destruiría documentos que nadie pidió borrar.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let otro: string;

/**
 * Un bucket de mentira que contesta por lo que de verdad le borraron.
 *
 * `existe` mira la lista: si devolviera siempre lo mismo, un barrido que
 * pregunta y uno que no darían el mismo resultado y estas pruebas no podrían
 * distinguirlos.
 *
 * `mudo` es R2 sin contestar — un 500, un timeout. Devuelve `null`, que es
 * «no sé», y es distinto de «no está».
 */
function bucketFalso(modo: 'borra' | 'mudo' = 'borra') {
  const pedidas: string[] = [];
  const yaNoEstan = new Set<string>();
  return {
    pedidas,
    almacen: {
      async borrar(keys: string[]) {
        pedidas.push(...keys);
        for (const k of keys) yaNoEstan.add(k);
        return { borradas: [...keys], fallidas: [] };
      },
      async existe(key: string) {
        if (modo === 'mudo') return null;
        return !yaNoEstan.has(key);
      },
    },
  };
}

/**
 * Un pool que se muere justo después de destruir el archivo.
 *
 * Falla el COMMIT de las transacciones que tocan `sources` —la que borra y la
 * que marca— y deja pasar las demás. Así queda el estado exacto del proceso
 * que murió: la anotación escrita, el archivo destruido, la fila viva y SIN
 * marcar. Fallar todos los commits no serviría: tampoco se anotaría nada y la
 * prueba estaría midiendo una base muerta.
 *
 * El `query` suelto pasa derecho: `eliminarFuente` lee por ahí la llave del
 * archivo antes de empezar, y sin eso no habría nada anotado que mirar.
 */
function poolQueSeMuereAlBorrar(real: Pool): Pool {
  return {
    query: (...args: unknown[]) => (real.query as (...a: unknown[]) => unknown)(...args),
    async connect() {
      const client = await real.connect();
      let tocoSources = false;
      return new Proxy(client, {
        get(destino, prop) {
          if (prop !== 'query') return Reflect.get(destino, prop);
          return (...args: unknown[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            if (/DELETE FROM sources|UPDATE sources/i.test(sql)) tocoSources = true;
            if (sql === 'COMMIT' && tocoSources) {
              return Promise.reject(new Error('se murió el proceso justo acá'));
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
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('ventana-751') RETURNING id"))
    .rows[0].id;
  otro = (await admin.query("INSERT INTO tenants (name) VALUES ('ventana-751-otro') RETURNING id"))
    .rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM pending_file_deletions WHERE tenant_id = ANY($1)', [
    [tenant, otro],
  ]);
  await admin.query('DELETE FROM chunks WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM sources WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

/**
 * Cada prueba arma su propio estado. Sin esto, la anotación que una deja
 * abierta a propósito la cuenta la siguiente y los números dejan de decir
 * qué pasó en la prueba que se está leyendo.
 */
beforeEach(async () => {
  await admin.query('DELETE FROM pending_file_deletions WHERE tenant_id = $1', [tenant]);
});

/**
 * Una fuente con archivo y ACTIVA: así está la que el negocio cita todos los
 * días, que es la que este arreglo protege. `addSource` la deja en
 * 'processing' porque la indexación viene después y acá no hay embeddings que
 * correr.
 */
const fuentePdf = async (nombre: string) => {
  const f = await withTenant(admin, tenant, (c) =>
    addSource(c, {
      tenantId: tenant,
      kind: 'pdf',
      name: nombre,
      r2Key: `${tenant}/conocimiento/${nombre}.pdf`,
      actor: 'test',
    }),
  );
  await admin.query("UPDATE sources SET status = 'active' WHERE id = $1", [f.id]);
  return f;
};

const estadoDe = async (id: string) =>
  (await admin.query('SELECT status FROM sources WHERE id = $1', [id])).rows[0]?.status;

const pendientesDe = async (t: string) =>
  (
    await admin.query(
      'SELECT id, source_id, r2_key, confirmed_at FROM pending_file_deletions WHERE tenant_id = $1 ORDER BY created_at',
      [t],
    )
  ).rows;

/** El barrido mirando TODO lo anotado, sin esperar los diez minutos. */
const barrer = (almacen: Parameters<typeof reconciliarBorradosPendientes>[2]['almacen']) =>
  reconciliarBorradosPendientes(admin, tenant, { almacen, antiguedadMinutos: 0 });

describe('borrados de archivo que quedaron a medias (#751)', () => {
  it('el proceso muere entre borrar el archivo y confirmar: el barrido marca la fuente', async () => {
    const bucket = bucketFalso();
    const f = await fuentePdf('poder-notarial');

    await expect(
      eliminarFuente(poolQueSeMuereAlBorrar(admin), {
        tenantId: tenant,
        sourceId: f.id,
        actor: 'test',
        almacen: bucket.almacen,
      }),
    ).rejects.toThrow();

    // Este es el estado que nadie podía ver: la fuente volvió viva y sin
    // marca —la marca de #631 tampoco pudo escribirse— y su PDF ya no está.
    expect(await estadoDe(f.id)).toBe('active');
    expect(bucket.pedidas).toContain(`${tenant}/conocimiento/poder-notarial.pdf`);

    const r = await barrer(bucket.almacen);

    expect(r.marcadas).toBe(1);
    expect(await estadoDe(f.id)).toBe('delete_failed');
    // Y la anotación queda cerrada: la próxima corrida no la vuelve a mirar.
    const filas = await pendientesDe(tenant);
    expect(filas.filter((x) => x.source_id === f.id).every((x) => x.confirmed_at)).toBe(true);
  });

  it('EL BARRIDO NO BORRA ARCHIVOS', async () => {
    const f = await fuentePdf('planilla-de-precios');
    // Un bucket que se niega a borrar: si el barrido lo intentara, la prueba
    // no falla por una cuenta que no cuadra sino por el intento mismo, que es
    // lo que de verdad está prohibido.
    const bucket = {
      async borrar(): Promise<{ borradas: string[]; fallidas: string[] }> {
        throw new Error('el barrido llamó a borrar y no debe, nunca');
      },
      // El archivo NO está: el caso donde el barrido tiene trabajo que hacer,
      // que es justo cuando podría tentarse de «terminar» el borrado.
      async existe() {
        return false;
      },
    };

    await anotarAMano(f.id, `${tenant}/conocimiento/planilla-de-precios.pdf`);
    const r = await barrer(bucket);

    expect(r.marcadas).toBe(1);
    expect(await estadoDe(f.id)).toBe('delete_failed');
  });

  it('si el archivo sigue estando, no pasó nada: no marca la fuente', async () => {
    const f = await fuentePdf('manual-de-garantia');
    // Anotación escrita y proceso muerto ANTES de tocar el bucket. Que haya
    // anotación no prueba que el archivo se haya borrado; eso lo dice el
    // bucket. Un barrido que decidiera por lo anotado rompería esta fuente.
    await anotarAMano(f.id, `${tenant}/conocimiento/manual-de-garantia.pdf`);

    const r = await barrer(bucketFalso().almacen);

    expect(r.marcadas).toBe(0);
    expect(r.cerradas).toBe(1);
    expect(await estadoDe(f.id)).toBe('active');
  });

  it('si el bucket no contesta, la anotación queda para la próxima corrida', async () => {
    const f = await fuentePdf('acta-de-directorio');
    await anotarAMano(f.id, `${tenant}/conocimiento/acta-de-directorio.pdf`);

    const r = await barrer(bucketFalso('mudo').almacen);

    // Ni marcada ni cerrada: un 500 de R2 no es «el archivo no está», y
    // tratarlo así marcaría fuentes sanas cada vez que el bucket tiene un mal
    // minuto.
    expect(r.sinDecidir).toBe(1);
    expect(r.marcadas).toBe(0);
    expect(await estadoDe(f.id)).toBe('active');
    const abiertas = (await pendientesDe(tenant)).filter(
      (x) => x.source_id === f.id && !x.confirmed_at,
    );
    expect(abiertas).toHaveLength(1);
  });

  it('si la fuente ya no está, cierra la anotación sin preguntarle a nadie', async () => {
    const inexistente = '00000000-0000-0000-0000-000000000751';
    await anotarAMano(inexistente, `${tenant}/conocimiento/fantasma.pdf`);
    // Si el barrido le preguntara al bucket por una fuente que ya no existe,
    // este almacén lo haría fallar: no hay nada que preguntar.
    const bucket = {
      async borrar(): Promise<{ borradas: string[]; fallidas: string[] }> {
        throw new Error('no debe borrar');
      },
      async existe(): Promise<boolean | null> {
        throw new Error('la fuente ya no está: no hay nada que preguntar');
      },
    };

    const r = await barrer(bucket);

    expect(r.cerradas).toBe(1);
    expect(r.marcadas).toBe(0);
  });

  it('un borrado que sale bien deja la anotación cerrada y nada que barrer', async () => {
    const bucket = bucketFalso();
    const f = await fuentePdf('folleto-viejo');

    await eliminarFuente(admin, {
      tenantId: tenant,
      sourceId: f.id,
      actor: 'test',
      almacen: bucket.almacen,
    });

    const suyas = (await pendientesDe(tenant)).filter((x) => x.source_id === f.id);
    expect(suyas).toHaveLength(1);
    expect(suyas[0].confirmed_at).not.toBeNull();

    // Y el barrido no encuentra nada: el camino feliz no le deja trabajo.
    const r = await barrer(bucket.almacen);
    expect(r.revisadas).toBe(0);
  });

  it('no mira lo recién anotado: un borrado en curso no es un borrado a medias', async () => {
    const f = await fuentePdf('cotizacion-de-hoy');
    await anotarAMano(f.id, `${tenant}/conocimiento/cotizacion-de-hoy.pdf`);

    // Con la antigüedad de verdad: la anotación tiene segundos de vida.
    const r = await reconciliarBorradosPendientes(admin, tenant, {
      almacen: bucketFalso().almacen,
      antiguedadMinutos: 10,
    });

    expect(r.revisadas).toBe(0);
    expect(await estadoDe(f.id)).toBe('active');
  });

  it('sin almacén configurado no decide nada: las anotaciones esperan', async () => {
    const f = await fuentePdf('contrato-sin-r2');
    await anotarAMano(f.id, `${tenant}/conocimiento/contrato-sin-r2.pdf`);

    const r = await reconciliarBorradosPendientes(admin, tenant, {
      almacen: null,
      antiguedadMinutos: 0,
    });

    expect(r.revisadas).toBe(0);
    expect(await estadoDe(f.id)).toBe('active');
    const abiertas = (await pendientesDe(tenant)).filter(
      (x) => x.source_id === f.id && !x.confirmed_at,
    );
    expect(abiertas).toHaveLength(1);
  });

  it('el barrido de un negocio no ve lo anotado por otro', async () => {
    await withTenant(admin, otro, (c) =>
      c.query(
        `INSERT INTO pending_file_deletions (tenant_id, source_id, r2_key)
         VALUES ($1, $2, $3)`,
        [otro, '00000000-0000-0000-0000-000000000752', `${otro}/conocimiento/ajeno.pdf`],
      ),
    );

    const mio = await barrer(bucketFalso().almacen);
    const ajenas = (await pendientesDe(otro)).filter((x) => !x.confirmed_at);

    // El barrido del otro negocio corrió y no tocó esta fila.
    expect(mio.revisadas).toBe(0);
    expect(ajenas).toHaveLength(1);
  });
});

/**
 * Deja la anotación escrita como la deja `eliminarFuente` antes de tocar el
 * bucket, y nada más.
 *
 * A mano y no llamando a `eliminarFuente`: lo que hay que armar es el estado
 * que queda cuando el proceso MUERE, y un proceso que murió no ejecutó el
 * resto. Escribirlo así es la forma honesta de tenerlo.
 */
async function anotarAMano(sourceId: string, r2Key: string): Promise<void> {
  await withTenant(admin, tenant, (c) =>
    c.query(
      `INSERT INTO pending_file_deletions (tenant_id, source_id, r2_key) VALUES ($1, $2, $3)`,
      [tenant, sourceId, r2Key],
    ),
  );
}
