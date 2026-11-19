import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  PROVEEDOR_POR_OMISION,
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
 * que nadie registró. Desde #1339 el por omisión es Zernio y Zavu salió
 * del código: los pares de prueba usan nombres de mentira, porque la
 * propiedad que se cuida es la RESOLUCIÓN, no el proveedor de turno.
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
  it('dos proveedores conviven en whatsapp; el mismo par dos veces, no', () => {
    registerProvider(adaptador('whatsapp', PROVEEDOR_POR_OMISION));
    // Un segundo adaptador del MISMO canal es justamente lo que esta ADR
    // habilita: si esto tirara, elegir proveedor volvería a ser una
    // decisión del despliegue entero.
    expect(() => registerProvider(adaptador('whatsapp', 'proveedor-propio'))).not.toThrow();
    // Lo que se rechaza es el duplicado exacto: el mismo par dos veces.
    expect(() => registerProvider(adaptador('whatsapp', 'proveedor-propio'))).toThrow(
      /Ya hay un adaptador/,
    );
    // Y el par que ya estaba sigue llegando a su adaptador.
    expect(proveedorDe({ kind: 'whatsapp', provider: 'proveedor-propio' })).toMatchObject({
      proveedor: 'proveedor-propio',
    });
  });
});

describe('proveedorDe resuelve por la cuenta', () => {
  it('el proveedor que la cuenta declara, y sin declarar, el de siempre', () => {
    const deZernio = adaptador('whatsapp', PROVEEDOR_POR_OMISION);
    const otro = adaptador('whatsapp', 'proveedor-propio');
    registerProvider(deZernio);
    registerProvider(otro);

    expect(proveedorDe({ kind: 'whatsapp', provider: PROVEEDOR_POR_OMISION })).toBe(deZernio);
    expect(proveedorDe({ kind: 'whatsapp', provider: 'proveedor-propio' })).toBe(otro);
    // Sin proveedor declarado: una cuenta que no dijo nada resuelve al por
    // omisión del registro (migración 0010 + `proveedorPorOmisionDelCanal`).
    expect(proveedorDe({ kind: 'whatsapp' })).toBe(deZernio);
  });

  it('un proveedor que nadie registró NO cae al de siempre', () => {
    registerProvider(adaptador('whatsapp', PROVEEDOR_POR_OMISION));
    // Caer al por omisión acá es exactamente lo que la ADR-0032 vino a
    // impedir: mandar los mensajes de un cliente por un proveedor que no
    // es el suyo. Que devuelva null y quien llame decida.
    expect(proveedorDe({ kind: 'whatsapp', provider: 'fantasma' })).toBeNull();
  });
});

describe('con base de datos, la cuenta declara y el arranque verifica', () => {
  it('nace con el proveedor por omisión de su canal y el huérfano se ve al arrancar', async () => {
    const cuenta = await withTenant(pool, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'Canal del proveedor',
        config: { senderId: 'snd-proveedor-de-la-cuenta' },
      }),
    );

    // El por omisión de whatsapp es Zernio desde la migración 0010, y
    // `rowToAccount` lo trae completo: lo que sale de la base SIEMPRE trae
    // proveedor.
    const leida = await withTenant(pool, tenant, (c) => getChannelAccount(c, tenant, cuenta.id));
    expect(leida.provider).toBe(PROVEEDOR_POR_OMISION);
    expect(leida.provider).toBe('zernio');

    // Con el adaptador de su proveedor registrado, esa cuenta no estorba.
    registerProvider(adaptador('whatsapp', 'zernio'));
    expect(await proveedoresSinAdaptador(pool)).not.toContain('zernio');

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
      'zernio',
    ]);
    const huerfanos = await proveedoresSinAdaptador(pool);
    expect(huerfanos).not.toContain('zernio');
    expect(huerfanos).not.toContain('fantasma');
  });

  it('una cuenta de webchat nace declarándose a sí misma, no al por omisión de whatsapp', async () => {
    // El hueco que cerró #1339: el DEFAULT de la columna es UNO para todos
    // los canales y no sabe el kind. Una cuenta de webchat nacida con ese
    // defecto declararía `zernio`, que no atiende webchat, y quedaría
    // huérfana de adaptador al primer arranque — con el guard de arriba
    // impidiendo levantar el proceso entero.
    const cuenta = await withTenant(pool, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'webchat',
        name: 'Chat del sitio',
      }),
    );
    const leida = await withTenant(pool, tenant, (c) => getChannelAccount(c, tenant, cuenta.id));
    expect(leida.provider).toBe('webchat');

    //
    // Se afirma SOLO lo que esta cuenta trae: la lista global de
    // `proveedoresSinAdaptador` es de toda la base compartida de la suite, y
    // lo que otro archivo haya dejado vivo ahí no es asunto de este caso.
  });

  // Que una cuenta DESCONECTADA con la etiqueta de un proveedor retirado
  // no estorbe el arranque — la mitad del punto de la migración 0011
  // (#1339)— se prueba contra la migración real en base efímera, en
  // `tests/migracion-0011-proveedor-de-quien-lo-atiende.test.ts`: acá la
  // lista de `proveedoresSinAdaptador` es de toda la base compartida de la
  // suite, y una cuenta que cambia de estado entre dos consultas mientras
  // otra suite corre es una carrera que enseña a apagar la prueba, no una
  // prueba del guard.
});
