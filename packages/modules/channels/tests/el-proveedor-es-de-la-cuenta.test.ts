import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  PROVEEDOR_POR_OMISION,
  getProvider,
  proveedorDe,
  registerProvider,
  resetProviders,
  type ChannelKind,
  type ChannelProvider,
} from '../domain/port';
import {
  createChannelAccount,
  getChannelAccount,
  proveedoresSinAdaptador,
} from '../application/accounts';

/**
 * El proveedor es de la CUENTA, no del despliegue (ADR-0032, #1316).
 *
 * Hasta acá el registro de adaptadores tenía la clave por CANAL y
 * `getProvider` devolvía «el que estuviera»: elegir proveedor era una
 * decisión del despliegue entero. Con clientes reales encima, cambiar de
 * proveedor a un negocio no puede cambiarle el proveedor a los demás.
 *
 * Este archivo prueba las tres mitades de la decisión: que el registro
 * admita un adaptador por (proveedor, canal), que la resolución vaya por la
 * cuenta, y que el arranque se entere de una cuenta que declara a alguien
 * que nadie registró.
 */

/** Un adaptador de mentira que solo se distingue por quién dice ser. */
function adaptador(kind: ChannelKind, proveedor: string): ChannelProvider {
  return {
    kind,
    proveedor,
    send: async () => ({ providerMessageId: `${proveedor}-m1` }),
    verifyWebhook: () => true,
    normalize: () => [],
  };
}

let pool: Pool;
let tenant: string;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
  await runMigrations(pool);
  tenant = (
    await pool.query("INSERT INTO tenants (name) VALUES ('proveedor-de-la-cuenta') RETURNING id")
  ).rows[0].id;
});

afterAll(async () => {
  // La cuenta se borra por tenant, no por id: lo que crea este archivo no
  // puede quedar en la base de la suite.
  await pool.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await pool.end();
});

// El registro es estado de proceso: cada caso arma el suyo desde cero.
beforeEach(resetProviders);

describe('el registro admite un adaptador por (proveedor, canal)', () => {
  it('zavu y zernio conviven en whatsapp; el mismo par dos veces, no', () => {
    registerProvider(adaptador('whatsapp', 'zavu'));
    // Un segundo adaptador del MISMO canal es justamente lo que esta ADR
    // habilita: si esto tirara, elegir proveedor volvería a ser una
    // decisión del despliegue entero.
    expect(() => registerProvider(adaptador('whatsapp', 'zernio'))).not.toThrow();
    // Lo que se rechaza es el duplicado exacto: el mismo par dos veces.
    expect(() => registerProvider(adaptador('whatsapp', 'zernio'))).toThrow(/Ya hay un adaptador/);
    // Y el par que ya estaba sigue llegando a su adaptador.
    expect(proveedorDe({ kind: 'whatsapp', provider: 'zernio' })).toMatchObject({
      proveedor: 'zernio',
    });
  });
});

describe('proveedorDe resuelve por la cuenta', () => {
  it('el proveedor que la cuenta declara, y sin declarar, el de siempre', () => {
    const deZernio = adaptador('whatsapp', 'zernio');
    const deZavu = adaptador('whatsapp', 'zavu');
    registerProvider(deZernio);
    registerProvider(deZavu);

    expect(proveedorDe({ kind: 'whatsapp', provider: 'zernio' })).toBe(deZernio);
    expect(proveedorDe({ kind: 'whatsapp', provider: 'zavu' })).toBe(deZavu);
    // Sin proveedor declarado: una cuenta anterior a la ADR-0032, que es la
    // que el DEFAULT de la migración 0006 dejó en 'zavu'.
    expect(proveedorDe({ kind: 'whatsapp' })).toBe(deZavu);
  });

  it('un proveedor que nadie registró NO cae al de siempre', () => {
    registerProvider(adaptador('whatsapp', 'zavu'));
    // Caer al por omisión acá es exactamente lo que la ADR-0032 vino a
    // impedir: mandar los mensajes de un cliente por un proveedor que no
    // es el suyo. Que devuelva null y quien llame decida.
    expect(proveedorDe({ kind: 'whatsapp', provider: 'zernio' })).toBeNull();
  });
});

describe('getProvider devuelve al POR OMISIÓN declarado, no «al que esté»', () => {
  it('zernio registrado primero no le quita a zavu el whatsapp', () => {
    // El orden de arranque no puede decidir quién atiende un canal: la
    // versión vieja devolvía «el único que hay» y el día que haya dos,
    // resolver por orden de registro se comporta distinto según quién
    // levantó primero. Esto es la regresión que esta ADR no permite.
    registerProvider(adaptador('whatsapp', 'zernio'));
    const deZavu = adaptador('whatsapp', 'zavu');
    registerProvider(deZavu);

    const resuelto = getProvider('whatsapp');
    expect(resuelto).toBe(deZavu);
    expect(resuelto?.proveedor).toBe(PROVEEDOR_POR_OMISION);
  });
});

describe('con base de datos, la cuenta declara y el arranque verifica', () => {
  it('nace con el proveedor por omisión y el huérfano se ve al arrancar', async () => {
    const cuenta = await withTenant(pool, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'Canal del proveedor',
        config: { senderId: 'snd-proveedor-de-la-cuenta' },
      }),
    );

    // La migración 0006 puso 'zavu' por omisión, y `rowToAccount` lo trae
    // completo: lo que sale de la base SIEMPRE trae proveedor.
    const leida = await withTenant(pool, tenant, (c) => getChannelAccount(c, tenant, cuenta.id));
    expect(leida.provider).toBe(PROVEEDOR_POR_OMISION);
    expect(leida.provider).toBe('zavu');

    // Con el adaptador de su proveedor registrado, esa cuenta no estorba.
    registerProvider(adaptador('whatsapp', 'zavu'));
    expect(await proveedoresSinAdaptador(pool)).not.toContain('zavu');

    // Una cuenta que declara a alguien que nadie registró: lo que la API y
    // los workers no dejan arrancar.
    await pool.query('UPDATE channel_accounts SET provider = $2 WHERE id = $1', [
      cuenta.id,
      'fantasma',
    ]);
    expect(await proveedoresSinAdaptador(pool)).toContain('fantasma');

    // Devuelta a su proveedor, no queda nada propio sin adaptador.
    await pool.query('UPDATE channel_accounts SET provider = $2 WHERE id = $1', [
      cuenta.id,
      'zavu',
    ]);
    const huerfanos = await proveedoresSinAdaptador(pool);
    expect(huerfanos).not.toContain('zavu');
    expect(huerfanos).not.toContain('fantasma');
  });
});