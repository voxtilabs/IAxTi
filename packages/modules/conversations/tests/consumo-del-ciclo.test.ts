import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { changePlan, getPlanLimits } from '@iaxti/module-organizations';
import { conversacionesPorPeriodo, receiveInbound } from '../application/conversations';

/**
 * El consumo del ciclo, reconstruible (#702).
 *
 * Una corrección a la medición del issue: `conversations.usage_period` **sí se
 * lee** — en el `WHERE ... IS DISTINCT FROM` del `UPDATE` que la estampa, que es
 * exactamente lo que hace que cada conversación se cuente UNA vez por ciclo. El
 * issue contó `SELECT`, y ahí el lector es el `WHERE`.
 *
 * Lo que faltaba era poder LISTARLA, y eso sí importa:
 * `.claude/rules/negocio.md` pide «costos visibles, sin margen escondido sobre
 * los costos de Meta». Una cifra que no se puede reconstruir desde las
 * conversaciones que la generaron no es verificable — ni por el cliente ni por
 * nosotros— y el consumo era un contador en `usage_meters` sin forma de abrirlo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let telefono = 56_955_100_000;
/** El ciclo tal como lo escribe `periodStart()`: `AAAA-MM-01`, no `AAAA-MM`. */
const CICLO = `${new Date().toISOString().slice(0, 7)}-01`;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query(
      "INSERT INTO tenants (name, plan, state) VALUES ('consumo-del-ciclo', 'base', 'active') RETURNING id",
    )
  ).rows[0].id;
});

afterAll(async () => {
  for (const t of ['messages', 'conversations', 'contacts', 'usage_meters', 'outbox']) {
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

/** Una conversación entrante nueva, que es lo que cuenta como activa del ciclo. */
async function entra(canal: 'whatsapp' | 'simulador' = 'whatsapp'): Promise<void> {
  telefono += 1;
  await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: `+${telefono}`, channel: canal, body: 'hola' }),
  );
}

const delCiclo = async (): Promise<number> =>
  (await withTenant(admin, tenant, (c) => conversacionesPorPeriodo(c, tenant)))
    .find((p) => p.periodo === CICLO)?.conversaciones ?? 0;

describe('el consumo del ciclo se puede reconstruir (#702)', () => {
  it('cuenta las conversaciones del ciclo, una vez cada una', async () => {
    await entra();
    await entra();
    expect(await delCiclo()).toBe(2);
  });

  it('el desglose CALZA con el medidor: salen del mismo hecho', async () => {
    // Es el punto del criterio 2. Si fueran dos caminos distintos, el día que
    // se separen nadie se enteraría y el cliente estaría viendo un número que
    // no corresponde a lo que se le cobra.
    const medidor = await admin.query(
      `SELECT value FROM usage_meters
        WHERE tenant_id = $1 AND metric = 'conversations' AND period_start = $2::date`,
      [tenant, CICLO],
    );
    expect(Number(medidor.rows[0].value)).toBe(await delCiclo());
  });

  it('un segundo mensaje de la MISMA conversación no vuelve a contar', async () => {
    // La marca es por ciclo y por conversación, y la dedupe es el WHERE del
    // UPDATE que la estampa — el lector que el issue dio por ausente.
    const telefonoExistente = (
      await admin.query('SELECT phone FROM contacts WHERE tenant_id = $1 ORDER BY created_at LIMIT 1', [
        tenant,
      ])
    ).rows[0].phone;
    const antes = await delCiclo();
    await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: telefonoExistente,
        channel: 'whatsapp',
        body: 'otra vez',
      }),
    );
    expect(await delCiclo()).toBe(antes);
  });

  it('el ciclo NO se parte al cambiar de plan: la métrica es del ciclo', async () => {
    // Criterio 4 del issue. Las conversaciones de antes y las de después del
    // cambio están en el mismo ciclo, y es deliberado: el medidor cuenta
    // conversaciones activas del CICLO, no del plan, y el tope del plan se
    // mide contra el ciclo. Partirlo sería cambiar la definición de la métrica
    // a mitad de camino, y entonces ni el tope ni la factura significarían lo
    // mismo antes y después.
    const antes = await delCiclo();
    await withTenant(admin, tenant, (c) => changePlan(c, tenant, 'crece'));
    await entra();

    const periodos = await withTenant(admin, tenant, (c) => conversacionesPorPeriodo(c, tenant));
    expect(periodos.filter((p) => p.periodo === CICLO), 'un solo período, no dos').toHaveLength(1);
    expect(await delCiclo()).toBe(antes + 1);
  });

  it('el tope del plan existe, para poder leer el número contra algo', async () => {
    const limites = await withTenant(admin, tenant, (c) => getPlanLimits(c, 'crece'));
    expect(limites.conversationsMonth).toBeGreaterThan(0);
  });

  it('el simulador NO cuenta: es la herramienta de prueba, no un cliente', async () => {
    const antes = await delCiclo();
    await entra('simulador');
    expect(await delCiclo()).toBe(antes);
  });

  it('un negocio sin conversaciones devuelve lista vacía, no un cero inventado', async () => {
    const otro = (
      await admin.query("INSERT INTO tenants (name, plan) VALUES ('sin-consumo', 'base') RETURNING id")
    ).rows[0].id;
    expect(await withTenant(admin, otro, (c) => conversacionesPorPeriodo(c, otro))).toEqual([]);
  });

  it('el límite de meses se sanea: un valor absurdo no revienta la consulta', async () => {
    // Viene de un `?meses=` del cliente, que es así de confiable.
    for (const meses of [0, -3, Number.NaN, 9999] as number[]) {
      const r = await withTenant(admin, tenant, (c) => conversacionesPorPeriodo(c, tenant, meses));
      expect(Array.isArray(r)).toBe(true);
    }
  });
});
