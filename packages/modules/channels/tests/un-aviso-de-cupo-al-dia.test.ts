import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { avisarDelCupoUnaVezAlDia, createChannelAccount } from '../contract';

/**
 * Un aviso de cupo al día, y no cincuenta (#1248).
 *
 * Cuando el cupo se agota hay muchos jobs en la cola y cada uno que se difiere
 * querría avisar. Cincuenta avisos iguales no son cincuenta veces más útiles
 * que uno: son una campana que el dueño silencia, y entonces el aviso que
 * importa tampoco llega.
 *
 * Por eso es un cerrojo —un `UPDATE` condicional— y no una comprobación.
 * Leer-y-después-escribir dejaría pasar dos.
 */
let pool: Pool;
let tenant: string;
let account: string;

const CUPO = { enviados: 200, tope: 250, quedan: 50, reserva: 50, topeAsumido: true };

const avisar = () =>
  withTenant(pool, tenant, (c) =>
    avisarDelCupoUnaVezAlDia(c, { tenantId: tenant, accountId: account, cupo: CUPO }),
  );

const eventos = async () =>
  (
    await pool.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'channel.quota_threshold'`,
      [tenant],
    )
  ).rows;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants (name) VALUES ('un-aviso-al-dia') RETURNING id"))
    .rows[0].id;
  const cuenta = await withTenant(pool, tenant, (c) =>
    createChannelAccount(c, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Canal del cupo',
      config: { phoneNumberId: 'pn-aviso' },
    }),
  );
  account = cuenta.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await pool?.end();
});

describe('un aviso de cupo al día (#1248)', () => {
  it('la primera vez avisa', async () => {
    expect(await avisar()).toBe(true);
    const e = await eventos();
    expect(e).toHaveLength(1);
    // El payload lleva con qué decidir, no solo que pasó algo.
    expect(e[0].payload).toMatchObject({
      channelAccountId: account,
      enviados: 200,
      tope: 250,
      quedan: 50,
      reservadosParaPersonas: 50,
      topeAsumido: true,
    });
  });

  it('las siguientes del mismo día NO avisan, y no publican nada', async () => {
    for (let i = 0; i < 5; i++) expect(await avisar(), `intento ${i + 2}`).toBe(false);
    expect(await eventos()).toHaveLength(1);
  });

  it('en paralelo gana UNO solo: es un cerrojo, no una comprobación', async () => {
    // Lo que de verdad pasa cuando el cupo se agota: varios workers a la vez.
    // Se limpia la marca para volver al estado del primer diferido del día.
    await pool.query(
      `UPDATE channel_accounts SET config = config - 'avisoDeCupo' WHERE tenant_id = $1 AND id = $2`,
      [tenant, account],
    );
    await pool.query(`DELETE FROM outbox WHERE tenant_id = $1`, [tenant]);

    const resultados = await Promise.all(Array.from({ length: 6 }, avisar));
    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(await eventos()).toHaveLength(1);
  });

  it('cuando el proveedor renueva el cupo, el aviso también se renueva', async () => {
    // La marca es el día UTC: con la de ayer, hoy vuelve a avisar.
    await pool.query(
      `UPDATE channel_accounts
          SET config = jsonb_set(config, '{avisoDeCupo}',
                                 to_jsonb(((now() AT TIME ZONE 'UTC')::date - 1)::text))
        WHERE tenant_id = $1 AND id = $2`,
      [tenant, account],
    );
    expect(await avisar()).toBe(true);
  });
});
