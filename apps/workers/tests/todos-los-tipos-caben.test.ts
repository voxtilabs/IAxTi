import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createZernioProvider } from '@iaxti/module-whatsapp';
import { receiveInbound, tipoQueSePuedeGuardar } from '@iaxti/module-conversations';

/**
 * Todo lo que el canal produce cabe en la tabla (#1266).
 *
 * Eran dos listas de la misma cosa en dos idiomas, y nadie las cruzó: la tabla
 * de tipos del adaptador de entonces producía 13 valores y el CHECK aceptaba
 * 8. `video` y `reaccion` faltaban, así que el INSERT reventaba y `withTenant`
 * revertía la transacción ENTERA — se perdía el mensaje y, si era el primero
 * de esa persona, también su contacto y su conversación.
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
 *
 * La lista NO se escribe acá: se le pregunta al adaptador de Zernio, que es
 * quien la produce (#870 — medir por el puerto del producto). Con la tabla
 * del adaptador de Zavu pasó lo que esta prueba existe para impedir: se
 * cambió el vocabulario de un lado y el otro se enteró por el INSERT que
 * reventaba.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;

/** Un `message.received` completo, como el spec v1.527 lo declara. */
const evento = (adjunto?: { type: string }) => ({
  id: 'evt-tipos',
  event: 'message.received',
  message: {
    id: 'interno-tipos',
    conversationId: 'conv-tipos',
    platformMessageId: 'wamid.TIPOS',
    direction: 'incoming',
    ...(adjunto ? {} : { text: 'Hola, tengo una duda' }),
    ...(adjunto
      ? { attachments: [{ type: adjunto.type, url: 'https://zernio.com/api/v1/whatsapp/media/m1', mimeType: 'application/octet-stream' }] }
      : {}),
    sender: { phoneNumber: '+56912345678' },
    sentAt: '2026-11-11T12:00:00Z',
  },
  conversation: { id: 'conv-tipos' },
  account: { id: 'acc-tipos', accountId: 'acc-tipos' },
});

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES('tipos que caben') RETURNING id")).rows[0].id;
});
afterAll(async () => { await pool?.end(); });

describe('los tipos del canal caben en la tabla (#1266)', () => {
  // Lo que el adaptador de Zernio produce HOY: un sobre por cada clase de
  // adjunto que su spec declara, más el texto pelado.
  const clases = ['image', 'video', 'audio', 'sticker', 'file', 'share'];
  const provider = createZernioProvider('whatsapp');
  const delCanal = [
    ...new Set(
      [evento(), ...clases.map((type) => evento({ type }))].flatMap(
        (sobre) => provider.normalize(sobre).map((m) => m.type),
      ),
    ),
  ].sort();

  it('la lista no es un conejo: el adaptador produce de verdad cada tipo', () => {
    // Si el adaptador deja de producir alguno de estos, el `it.each` de
    // abajo se achica en silencio y la guarda se vacía. Esto lo hace visible.
    expect(delCanal).toEqual(['audio', 'documento', 'imagen', 'texto', 'video']);
  });

  it.each(delCanal)('un entrante de tipo %s entra y abre la ventana', async (tipo) => {
    const telefono = `+569${String(Date.now()).slice(-7)}${delCanal.indexOf(tipo)}`;
    const r = await withTenant(pool, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        channel: 'whatsapp',
        phone: telefono,
        type: tipo as never,
        body: 'hola',
        providerMessageId: `tipos-${tipo}-${telefono}`,
      }),
    );
    // El tipo que se pidió guardar es el que quedó (#1266): el CHECK pudo
    // haberlo cambiado en silencio a otro y la fila igual entraba.
    expect(r.message.type).toBe(tipo);
    // Y el dominio lo reconoce POR SU NOMBRE — devuelve el mismo tipo y no
    // lo dobla a `texto`, que es lo que hace con el que no conoce.
    expect(tipoQueSePuedeGuardar(tipo)).toBe(tipo);
  });
});
