import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool, runMigrations } from '@iaxti/db';

/**
 * #526: el emisor que el adaptador lee no quedó donde lo lee.
 *
 * ADR-0014 movió el identificador operativo a `sender_id` y la migración 0003
 * lo agregó a `whatsapp_numbers`. No tocó el `config` de `channel_accounts`,
 * que es de donde el adaptador de Zavu saca el emisor para ENVIAR. Una cuenta
 * conectada antes de eso recibe mensajes sin problema —el entrante se resuelve
 * por el id de la cuenta del webhook— y falla todos los envíos.
 *
 * Esta prueba arma la forma vieja y corre el .sql de verdad, no una copia.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const SQL = readFileSync(
  join(__dirname, '..', 'migrations', '0005_sender_en_la_cuenta.sql'),
  'utf8',
);

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('wa-0005') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

/** Una cuenta como quedaban antes de ADR-0014: sin `senderId` en el config. */
async function cuentaVieja(opciones: { senderId: string | null; phoneNumberId: string | null }) {
  const nombre = `Numero ${randomUUID().slice(0, 8)}`;
  const ca = await admin.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, credential_ref, config)
     VALUES ($1, 'whatsapp', $2, 'LLAVE', $3::jsonb) RETURNING id`,
    [tenant, nombre, JSON.stringify({ phoneNumberId: opciones.phoneNumberId })],
  );
  await admin.query(
    `INSERT INTO whatsapp_numbers (tenant_id, channel_account_id, sender_id, phone_number_id, connected_at)
     VALUES ($1, $2, $3, $4, now())`,
    [tenant, ca.rows[0].id, opciones.senderId, opciones.phoneNumberId],
  );
  return ca.rows[0].id as string;
}

const configDe = async (id: string) =>
  (await admin.query('SELECT config FROM channel_accounts WHERE id = $1', [id])).rows[0].config as
    Record<string, unknown>;

describe('migración 0005: el emisor llega al config (#526)', () => {
  it('lo rellena desde sender_id', async () => {
    const id = await cuentaVieja({ senderId: 'sender-zavu-1', phoneNumberId: 'pn-1' });
    expect(await configDe(id)).not.toHaveProperty('senderId');
    await admin.query(SQL);
    expect((await configDe(id)).senderId).toBe('sender-zavu-1');
  });

  it('sin sender_id, cae al phone_number_id — que ERA el identificador operativo', async () => {
    // No es una adivinanza: antes de ADR-0014 el id del número de Meta era el
    // identificador con el que se mandaba, así que para una cuenta de esa
    // época ese es el valor correcto.
    const id = await cuentaVieja({ senderId: null, phoneNumberId: 'pn-meta-viejo' });
    await admin.query(SQL);
    expect((await configDe(id)).senderId).toBe('pn-meta-viejo');
    // Y la columna queda coherente con el config: si no, el diagnóstico y el
    // envío discreparían sobre la misma cuenta.
    const fila = await admin.query(
      'SELECT sender_id FROM whatsapp_numbers WHERE channel_account_id = $1',
      [id],
    );
    expect(fila.rows[0].sender_id).toBe('pn-meta-viejo');
  });

  it('no pisa un emisor que ya estaba', async () => {
    const nombre = `Ya tenia ${randomUUID().slice(0, 8)}`;
    const ca = await admin.query(
      `INSERT INTO channel_accounts (tenant_id, kind, name, credential_ref, config)
       VALUES ($1, 'whatsapp', $2, 'LLAVE', '{"senderId":"el-bueno"}'::jsonb) RETURNING id`,
      [tenant, nombre],
    );
    await admin.query(
      `INSERT INTO whatsapp_numbers (tenant_id, channel_account_id, sender_id, connected_at)
       VALUES ($1, $2, 'otro-distinto', now())`,
      [tenant, ca.rows[0].id],
    );
    await admin.query(SQL);
    expect((await configDe(ca.rows[0].id)).senderId).toBe('el-bueno');
  });

  it('una cuenta sin número conectado se queda como está, sin inventarle un emisor', async () => {
    const ca = await admin.query(
      `INSERT INTO channel_accounts (tenant_id, kind, name, credential_ref, config)
       VALUES ($1, 'whatsapp', $2, 'LLAVE', '{}'::jsonb) RETURNING id`,
      [tenant, `Huerfana ${randomUUID().slice(0, 8)}`],
    );
    await admin.query(SQL);
    expect(await configDe(ca.rows[0].id)).not.toHaveProperty('senderId');
  });

  it('correrla dos veces no cambia nada', async () => {
    const id = await cuentaVieja({ senderId: 'sender-idem', phoneNumberId: 'pn-idem' });
    await admin.query(SQL);
    await admin.query(SQL);
    expect((await configDe(id)).senderId).toBe('sender-idem');
  });
});
