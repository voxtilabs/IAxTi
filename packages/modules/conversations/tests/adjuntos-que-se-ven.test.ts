import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { listMessages, receiveInbound } from '../application/conversations';

/**
 * Los adjuntos se guardaban y nadie los miraba (#460).
 *
 * Desde #42 lo que manda el cliente se baja al llegar —Meta expira sus
 * URLs— y queda en R2 con prefijo por tenant. Pero `listMessages` no
 * proyectaba la columna: un mensaje que era SOLO una foto llegaba a la
 * bandeja como una burbuja vacía. La foto era todo el mensaje.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const r = await admin.query("INSERT INTO tenants (name) VALUES ('conv-adjuntos') RETURNING id");
  tenant = r.rows[0].id;
});

afterAll(async () => {
  await admin?.end();
});

describe('adjuntos en el mensaje', () => {
  it('llegan a la bandeja con su llave y su nombre', async () => {
    const { conversation } = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '+56911111111',
        type: 'imagen',
        attachments: [
          { key: `${tenant}/whatsapp/boleta.jpg`, name: 'boleta.jpg', contentType: 'image/jpeg' },
        ],
      }),
    );
    const [mensaje] = await withTenant(admin, tenant, (c) =>
      listMessages(c, tenant, conversation.id),
    );
    expect(mensaje.attachments).toEqual([
      { key: `${tenant}/whatsapp/boleta.jpg`, name: 'boleta.jpg', contentType: 'image/jpeg' },
    ]);
    expect(mensaje.lostAttachments).toBe(0);
  });

  it('el que no se alcanzó a guardar se cuenta, no se muestra', async () => {
    // El inbound tolera que la descarga falle —perder el texto por un
    // adjunto sería peor— y deja la metadata original, sin llave. Esa URL
    // del proveedor ya caducó: no hay nada que abrir, pero sí algo que
    // decirle a quien atiende.
    const { conversation } = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '+56922222222',
        type: 'imagen',
        attachments: [{ url: 'https://meta.example/media/abc', contentType: 'image/jpeg' }],
      }),
    );
    const [mensaje] = await withTenant(admin, tenant, (c) =>
      listMessages(c, tenant, conversation.id),
    );
    expect(mensaje.attachments).toEqual([]);
    expect(mensaje.lostAttachments).toBe(1);
  });

  it('un mensaje sin adjuntos trae una lista vacía, no undefined', async () => {
    // La bandeja hace `m.attachments.length` en cada burbuja.
    const { conversation } = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56933333333', body: 'Hola' }),
    );
    const [mensaje] = await withTenant(admin, tenant, (c) =>
      listMessages(c, tenant, conversation.id),
    );
    expect(mensaje.attachments).toEqual([]);
    expect(mensaje.lostAttachments).toBe(0);
  });

  it('el nombre sale de la llave cuando el proveedor no mandó ninguno', async () => {
    const { conversation } = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '+56944444444',
        type: 'documento',
        attachments: [{ key: `${tenant}/whatsapp/contrato.pdf` }],
      }),
    );
    const [mensaje] = await withTenant(admin, tenant, (c) =>
      listMessages(c, tenant, conversation.id),
    );
    expect(mensaje.attachments[0].name).toBe('contrato.pdf');
    expect(mensaje.attachments[0].contentType).toBe('application/octet-stream');
  });
});
