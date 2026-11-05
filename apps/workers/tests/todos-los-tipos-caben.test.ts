import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { TIPOS } from '@iaxti/module-whatsapp';
import { receiveInbound, tipoQueSePuedeGuardar } from '@iaxti/module-conversations';

/**
 * Todo lo que el canal produce cabe en la tabla (#1266).
 *
 * Eran dos listas de la misma cosa en dos idiomas, y nadie las cruzó: `TIPOS`
 * en el adaptador de Zavu producía 13 valores y el CHECK aceptaba 8. `video`
 * y `reaccion` faltaban, así que el INSERT reventaba y `withTenant` revertía
 * la transacción ENTERA — se perdía el mensaje y, si era el primero de esa
 * persona, también su contacto y su conversación.
 *
 * Para el cliente: dos ticks. Para el negocio: nada. Y como el entrante no
 * quedaba, la ventana de 24 h no se abría nunca.
 *
 * Esta prueba cruza las dos listas contra la base DE VERDAD. Comprobarlo
 * contra la unión de TypeScript no habría servido: las dos listas eran
 * coherentes con su propio idioma y el defecto vivía justo en medio.
 *
 * Y vive en `apps/workers` y no en ninguno de los dos módulos a propósito:
 * `conversations` no declara `whatsapp` ni al revés, y el único lugar donde
 * las dos listas se encuentran de verdad es el camino de entrada, que es
 * esto. Ponerla dentro de un módulo habría obligado a inventar una
 * dependencia que no existe.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES('tipos que caben') RETURNING id")).rows[0].id;
});
afterAll(async () => { await pool?.end(); });

describe('los tipos del canal caben en la tabla (#1266)', () => {
  const delCanal = [...new Set(Object.values(TIPOS))].sort();

  it.each(delCanal)('un entrante de tipo %s entra y abre la ventana', async (tipo) => {
    const telefono = `+569${String(Date.now()).slice(-7)}${delCanal.indexOf(tipo)}`;
    const r = await withTenant(pool, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        channel: 'whatsapp',
        phone: telefono,
        type: tipo as never,
        body: 'lo que sea',
        providerMessageId: `prueba-${tipo}-${randomUUID()}`,
      }),
    );
    expect(r.message.type).toBe(tipo);
    // Lo segundo importa tanto como lo primero: un entrante perdido deja la
    // ventana de 24 h cerrada, y después el negocio no le puede escribir.
    expect(r.conversation.lastInboundAt).not.toBeNull();
  });

  /**
   * El próximo tipo que estrene el proveedor. El CHECK ensanchado arregla los
   * dos que faltaban; esto arregla el que todavía no existe.
   */
  it('un tipo que nadie conoce entra como texto en vez de tirar la transacción', async () => {
    const r = await withTenant(pool, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        channel: 'whatsapp',
        phone: `+5699${String(Date.now()).slice(-7)}`,
        type: 'holograma' as never,
        body: 'del futuro',
        providerMessageId: `prueba-futuro-${randomUUID()}`,
      }),
    );
    expect(r.message.type).toBe('texto');
    expect(r.message.body).toBe('del futuro');
  });

  it('la red no toca lo que sí conoce', () => {
    expect(tipoQueSePuedeGuardar('video')).toBe('video');
    expect(tipoQueSePuedeGuardar('reaccion')).toBe('reaccion');
    expect(tipoQueSePuedeGuardar(undefined)).toBe('texto');
  });
});
