import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { writeAudit } from '../src/write';
import { searchAudit, searchAuditPaginado } from '../src/search';

/**
 * Paginar el libro por cursor, nunca por offset (#799).
 *
 * El libro es donde alguien pregunta «quién cambió esto». Devolvía hasta cien
 * filas y no había forma de pedir la 101: si lo que se buscaba estaba ahí, la
 * respuesta era «no existe» — sobre auditoría, que es el peor lugar para un
 * «no existe» que en realidad es «está en la página 2».
 *
 * Por qué keyset y no `OFFSET`: entre dos páginas se escriben filas nuevas —el
 * libro recibe una por cada mutación del producto— y con offset esas filas
 * corren todo, así que la 101 se saltea. En un libro de auditoría eso es una
 * entrada que nadie ve jamás, y es justo la que alguien está buscando.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let admin: Pool;
let tenant: string;

/**
 * Las siete se escriben en UNA transacción, y eso les da el mismo instante.
 *
 * No hace falta forzarlo: `now()` en Postgres es la hora de inicio de la
 * TRANSACCIÓN, no del statement, así que las siete filas comparten
 * `occurred_at` al microsegundo. Es exactamente lo que pasa en producción
 * —una mutación del producto escribe varias filas de auditoría en su
 * transacción— y es el caso que rompe un cursor que compare solo la fecha.
 *
 * La primera versión de esta prueba le pasaba un `occurredAt` a `writeAudit`
 * para forzarlo. No existe ese parámetro: el runtime lo ignoraba en silencio
 * y el typecheck del monorepo lo cazó. El caso se daba igual, por el motivo
 * de arriba, que además es más fiel a lo que ocurre de verdad.
 */
beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('paginar') RETURNING id")).rows[0]
    .id as string;
  await withTenant(admin, tenant, async (c) => {
    for (let i = 0; i < 7; i++) {
      await writeAudit(c, {
        tenantId: tenant,
        actor: 'u1',
        actorKind: 'user',
        action: 'prueba.paginar',
        resource: 'cosa',
        resourceId: `r-${i}`,
        result: 'ok',
      });
    }
  });
});

afterAll(async () => {
  const { sinTriggers } = await import('@iaxti/db');
  await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

const DEL_CASO = { action: 'prueba.paginar' };

describe('paginar el libro (#799)', () => {
  it('sin cursor devuelve el array de siempre: /v1 no cambia de forma', async () => {
    const filas = await withTenant(admin, tenant, (c) => searchAudit(c, DEL_CASO));
    expect(Array.isArray(filas)).toBe(true);
    expect(filas).toHaveLength(7);
  });

  it('recorre TODAS las entradas sin repetir ni saltear, de a tres', async () => {
    const vistas: string[] = [];
    let cursor: string | undefined;
    let vueltas = 0;
    do {
      const { entries, nextCursor } = await withTenant(admin, tenant, (c) =>
        searchAuditPaginado(c, { ...DEL_CASO, limit: 3, cursor }),
      );
      vistas.push(...entries.map((e: { resource_id: string }) => e.resource_id));
      cursor = nextCursor ?? undefined;
      vueltas += 1;
      expect(vueltas, 'se pasó de vueltas: el cursor no avanza').toBeLessThan(10);
    } while (cursor);

    // Las siete, una sola vez cada una. Es lo que prueba que el keyset no
    // repite la última de cada página ni se saltea la primera de la siguiente.
    expect(vistas).toHaveLength(7);
    expect(new Set(vistas).size).toBe(7);
    expect(vueltas).toBe(3);
  });

  it('las siete comparten instante: sin la tupla, el cursor se tranca o repite', async () => {
    // Todas se escribieron con el mismo `occurred_at`, que no es un caso
    // rebuscado: una transacción del producto escribe varias filas y todas
    // caen en el mismo microsegundo. Comparando solo la fecha, `< fecha`
    // devolvería cero filas en la segunda página —se tranca— o `<= fecha`
    // devolvería las mismas —repite—. La comparación va por `(occurred_at, id)`.
    const p1 = await withTenant(admin, tenant, (c) =>
      searchAuditPaginado(c, { ...DEL_CASO, limit: 3 }),
    );
    const p2 = await withTenant(admin, tenant, (c) =>
      searchAuditPaginado(c, { ...DEL_CASO, limit: 3, cursor: p1.nextCursor! }),
    );
    expect(p2.entries).toHaveLength(3);
    const ids1 = p1.entries.map((e: { id: string }) => e.id);
    const ids2 = p2.entries.map((e: { id: string }) => e.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('`nextCursor` en null significa que no hay más, y se sabe de verdad', async () => {
    // Siete filas y un tope de siete: con «vinieron exactamente las que pedí,
    // deben quedar más» esto diría que hay otra página, y la siguiente vendría
    // vacía. Se piden tope+1 para saberlo sin mentir.
    const r = await withTenant(admin, tenant, (c) =>
      searchAuditPaginado(c, { ...DEL_CASO, limit: 7 }),
    );
    expect(r.entries).toHaveLength(7);
    expect(r.nextCursor).toBeNull();
  });

  it('un cursor ilegible no revienta: vuelve a la primera página', async () => {
    const r = await withTenant(admin, tenant, (c) =>
      searchAuditPaginado(c, { ...DEL_CASO, cursor: 'esto-no-es-un-cursor' }),
    );
    expect(r.entries).toHaveLength(7);
  });

  it('una fila escrita entre dos páginas no corre el resto (lo que offset rompe)', async () => {
    const p1 = await withTenant(admin, tenant, (c) =>
      searchAuditPaginado(c, { ...DEL_CASO, limit: 3 }),
    );
    // Llega una entrada nueva, más reciente que todas: con OFFSET 3 la segunda
    // página devolvería la tercera fila otra vez, porque todo corrió un lugar.
    await withTenant(admin, tenant, (c) =>
      writeAudit(c, {
        tenantId: tenant,
        actor: 'u1',
        actorKind: 'user',
        action: 'prueba.paginar',
        resource: 'cosa',
        resourceId: 'r-intruso',
        // Va en su propia transacción, así que su `now()` es posterior al de
        // las siete: es la fila que llega DESPUÉS de la primera página.
        result: 'ok',
      }),
    );
    const p2 = await withTenant(admin, tenant, (c) =>
      searchAuditPaginado(c, { ...DEL_CASO, limit: 3, cursor: p1.nextCursor! }),
    );
    const ids1 = p1.entries.map((e: { id: string }) => e.id);
    expect(p2.entries.some((e: { id: string }) => ids1.includes(e.id))).toBe(false);
    // Y la intrusa no aparece: es más nueva que el cursor, así que queda
    // detrás. Eso es correcto — la página siguiente sigue desde donde quedó.
    expect(p2.entries.map((e: { resource_id: string }) => e.resource_id)).not.toContain('r-intruso');
  });
});
