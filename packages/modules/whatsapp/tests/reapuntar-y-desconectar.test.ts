import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  connectWhatsAppNumber,
  desconectarNumero,
  listWhatsAppNumbers,
} from '../application/numbers';

/**
 * Desconectar el canal (#600).
 *
 * El caso que lo pide es el que vivimos: un número quemado —degradado por
 * calidad, o que ya no existe en el proveedor— no tenía salida. #591 hizo que
 * el diagnóstico lo dijera, pero decirlo no era arreglarlo:
 *
 *  - `connectWhatsAppNumber` se niega a correr de nuevo: «Ese número ya está
 *    conectado en IAxTi.», más el tope de números del plan.
 *  - No había ruta para desconectar, así que el único camino era entrar a la
 *    base a mano, para algo que un ADMIN tiene que poder hacer desde su
 *    pantalla.
 *
 * La otra mitad del issue, REAPUNTAR el emisor, se fue con Zavu (#1339): era
 * el parche para una llave de proyecto que cambiaba de emisor, y el alta de
 * Zernio no tiene ese problema — conecta la cuenta que es, con su perfil.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query("INSERT INTO tenants (name, plan) VALUES ('reapuntar-600', 'base') RETURNING id")
  ).rows[0].id;
  // El plan base permite un número: es lo que hace interesante el cupo.
  await admin.query(
    `INSERT INTO plan_limits (plan, whatsapp_numbers, conversations_month, ia_executions_month,
                              retention_months, api_requests_month, modules)
     VALUES ('base', 1, 1000, 100, 12, 10000, '[]'::jsonb)
     ON CONFLICT (plan) DO NOTHING`,
  );
});

afterAll(async () => {
  for (const tabla of ['whatsapp_numbers', 'channel_accounts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

/** Un número conectado, con su cuenta de canal. */
async function conectado(senderId: string, extra?: { enviosReales?: boolean }) {
  return withTenant(admin, tenant, (c) =>
    connectWhatsAppNumber(c, {
      tenantId: tenant,
      name: 'WhatsApp del negocio',
      senderId,
      phoneNumberId: 'pn_viejo',
      displayPhone: '+56912345678',
      credentialRef: 'ZERNIO_LLAVE_600',
      webhookSecretRef: 'ZERNIO_WEBHOOK_SECRET_600',
      ...(extra?.enviosReales ? { enviosReales: true } : {}),
    }),
  );
}

describe('desconectar el canal (#600)', () => {
  it('archiva el número, deja el canal desconectado y LIBERA el cupo del plan', async () => {
    await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    const { account } = await conectado('snd_para_dar_de_baja');

    // Con el cupo tomado, conectar otro se rechaza: es el estado del que hay
    // que poder salir.
    await expect(conectado('snd_el_segundo')).rejects.toThrow(/Tu plan permite 1 número/);

    const { number, account: despues } = await withTenant(admin, tenant, (c) =>
      desconectarNumero(c, { tenantId: tenant, accountId: account.id }),
    );
    expect(number.disconnectedAt).not.toBeNull();
    expect(despues.state).toBe('disconnected');

    // La fila SIGUE: las conversaciones cuelgan de la cuenta y borrarla dejaría
    // el historial sin de dónde salió (SPEC §39).
    //
    // Se pide explícitamente: desde #772 la lista NO trae los archivados, y por
    // una razón que esta prueba casi escondió — `GET /channels` entrega esa
    // lista y la interfaz decidía con ella si se puede mandar una campaña, así
    // que una fila archivada sin `quality` bloqueaba todas las campañas del
    // negocio.
    const filas = await withTenant(admin, tenant, (c) =>
      listWhatsAppNumbers(c, tenant, { incluirDesconectados: true }),
    );
    expect(filas).toHaveLength(1);
    // Y por defecto no está: es lo que ve la API.
    const vivos = await withTenant(admin, tenant, (c) => listWhatsAppNumbers(c, tenant));
    expect(vivos).toHaveLength(0);

    // Y el cupo quedó libre: esto es la mitad del problema que el issue nombra.
    await expect(conectado('snd_el_segundo')).resolves.toBeTruthy();
  });

  it('el mismo emisor se puede volver a conectar después de desconectarlo', async () => {
    // El único de `sender_id` ignoraba el archivado y tiraba «Ese número ya
    // está conectado en IAxTi.» — el mensaje más equivocado posible: no está
    // conectado, está archivado. Un índice que impide reconectar lo que uno
    // mismo desconectó no cuida nada.
    await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    const { account } = await conectado('snd_que_vuelve');
    await withTenant(admin, tenant, (c) =>
      desconectarNumero(c, { tenantId: tenant, accountId: account.id }),
    );
    await expect(conectado('snd_que_vuelve')).resolves.toBeTruthy();
  });

  it('desconectar dos veces lo dice en vez de callar', async () => {
    await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    const { account } = await conectado('snd_dos_veces');
    await withTenant(admin, tenant, (c) =>
      desconectarNumero(c, { tenantId: tenant, accountId: account.id }),
    );
    await expect(
      withTenant(admin, tenant, (c) =>
        desconectarNumero(c, { tenantId: tenant, accountId: account.id }),
      ),
    ).rejects.toThrow(/no tiene un número de WhatsApp conectado/i);
  });
});
