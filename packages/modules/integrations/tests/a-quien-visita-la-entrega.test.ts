import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createEndpoint } from '../application/webhooks';

/**
 * A quién visita el barrido de entregas (#743, ADR-0026).
 *
 * `deliverWebhooks` recorría TODOS los tenants vivos. **No salía rojo en las
 * pruebas** porque la de entregas ya tiene su presupuesto declarado (#728): el
 * costo estaba ahí, tapado por el arreglo del síntoma. Medido el 09/10 con 1.283
 * tenants: 4,5 ms cada uno, ~5,8 s el barrido entero — y éste corre seguido,
 * porque es el que entrega los webhooks del cliente.
 *
 * Lo que estas pruebas cuidan tiene dos mitades: que **no se pierda una entrega**,
 * y que el filtro **respete los estados del tenant**. Lo segundo importa más de lo
 * que parece: pasar `ids` cortocircuita el `estados` que traía la llamada, y ese
 * filtro estaba ahí porque «una cuenta suspendida no manda NADA hacia afuera, y
 * los webhooks eran el único camino de salida que no lo respetaba».
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
// `catalog` es un Set: `createEndpoint` pregunta con `.has`.
const CATALOGO = new Set(['deal.won', 'payment.received']);

let admin: Pool;
const tenants: string[] = [];

/** Un tenant con una entrega pendiente que vence en `horas`, o sin ninguna. */
async function tenantConEntrega(horas: number | null, estado = 'active'): Promise<string> {
  const id = (
    await admin.query('INSERT INTO tenants (name, state) VALUES ($1, $2) RETURNING id', [
      'entregas-filtro',
      estado,
    ])
  ).rows[0].id;
  tenants.push(id);
  if (horas === null) return id;
  const ep = await withTenant(admin, id, (c) =>
    createEndpoint(c, {
      tenantId: id,
      url: 'https://cliente.cl/hooks',
      events: ['deal.won'],
      catalog: CATALOGO,
      actor: 'test',
    }),
  );
  await admin.query(
    `INSERT INTO webhook_deliveries
       (tenant_id, endpoint_id, event_id, event_name, payload, status, next_retry_at)
     VALUES ($1, $2, $3, 'deal.won', '{}'::jsonb, 'pending', now() + make_interval(hours => $4))`,
    [id, ep.id, Math.floor(Math.random() * 1_000_000), horas],
  );
  return id;
}

const visitados = async (): Promise<string[]> =>
  (await admin.query('SELECT tenant_id FROM tenants_con_entregas_pendientes()')).rows.map(
    (f) => f.tenant_id as string,
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    for (const tabla of ['webhook_deliveries', 'webhook_endpoints', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

describe('a quién visita el barrido de entregas (#743)', () => {
  it('con una entrega vencida, el tenant entra', async () => {
    const id = await tenantConEntrega(-1);
    expect(await visitados()).toContain(id);
  });

  it('con el reintento en el futuro, no entra todavía: es el backoff', async () => {
    const id = await tenantConEntrega(2);
    expect(await visitados()).not.toContain(id);
  });

  it('sin ninguna entrega, no entra. Es el caso de la mayoría', async () => {
    const id = await tenantConEntrega(null);
    expect(await visitados()).not.toContain(id);
  });

  it('un tenant SUSPENDIDO no entra, aunque tenga entregas vencidas', async () => {
    // Ésta es la mitad que importa. Pasar `ids` cortocircuita el `estados` de la
    // llamada, así que si el filtro no replicara el estado, los suspendidos
    // volverían a mandar webhooks sin que nada lo dijera. «Una cuenta suspendida
    // no manda NADA hacia afuera».
    const id = await tenantConEntrega(-1, 'suspended');
    expect(await visitados()).not.toContain(id);
  });

  it('uno en solo lectura SÍ entra: §6 restringe lo que INICIA el negocio', async () => {
    // Cortarle el sincronizado de su CRM por un atraso en el pago sería castigar
    // más de lo que la regla dice. Y es el control del caso de arriba: si todo
    // estado raro quedara fuera, la prueba anterior no probaría nada.
    const id = await tenantConEntrega(-1, 'read_only');
    expect(await visitados()).toContain(id);
  });

  it('uno borrado no entra', async () => {
    const id = await tenantConEntrega(-1, 'deleted');
    expect(await visitados()).not.toContain(id);
  });

  it('la función devuelve SOLO ids', async () => {
    const r = await admin.query('SELECT * FROM tenants_con_entregas_pendientes() LIMIT 1');
    expect(r.fields.map((f) => f.name)).toEqual(['tenant_id']);
  });

  it('no repite al que tiene varias entregas vencidas', async () => {
    const id = await tenantConEntrega(-1);
    const ep = (
      await admin.query('SELECT id FROM webhook_endpoints WHERE tenant_id = $1 LIMIT 1', [id])
    ).rows[0].id;
    await admin.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, endpoint_id, event_id, event_name, payload, status, next_retry_at)
       VALUES ($1, $2, $3, 'deal.won', '{}'::jsonb, 'pending', now() - interval '1 hour')`,
      [id, ep, Math.floor(Math.random() * 1_000_000)],
    );
    const lista = await visitados();
    expect(lista.filter((t) => t === id)).toHaveLength(1);
  });

  it('el estado que filtra la función es el MISMO que el de la llamada', async () => {
    // Si se separan, el día que alguien cambie uno el otro queda viejo — y acá
    // «viejo» significa mandarle webhooks a una cuenta suspendida. Los dos
    // lugares se leen juntos, y esto lo afirma.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(
      join(__dirname, '..', 'migrations', '0002_quien_tiene_entregas.sql'),
      'utf8',
    );
    const codigo = readFileSync(join(__dirname, '..', 'application', 'webhooks.ts'), 'utf8');
    for (const estado of ['trial', 'active', 'past_due', 'read_only']) {
      expect(sql, `la función tiene que incluir ${estado}`).toContain(`'${estado}'`);
      expect(codigo, `la llamada tiene que incluir ${estado}`).toContain(`'${estado}'`);
    }
    expect(sql, 'suspended NO puede estar en la función').not.toMatch(/'suspended'/);
  });
});
