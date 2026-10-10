import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  connectWhatsAppNumber,
  desconectarNumero,
  listWhatsAppNumbers,
  reapuntarEmisor,
} from '../application/numbers';
import { elegirSender, emisoresDelProveedor } from '../application/conectar';
import { getChannelAccount } from '@iaxti/module-channels';

/**
 * Reapuntar un canal y desconectarlo (#600).
 *
 * El caso que lo pide es el que vivimos: staging pasa de llave de prueba a
 * llave de producción, y si esa llave es de otro proyecto en Zavu el `senderId`
 * guardado **no existe allá**. Desde #591 el diagnóstico lo dice —«el emisor
 * guardado ya no existe en el proveedor»— pero decirlo no era arreglarlo:
 *
 *  - `connectWhatsAppNumber` se niega a correr de nuevo: «Ese número ya está
 *    conectado en IAxTi.», más el tope de números del plan.
 *  - No había ruta para cambiar el emisor de una cuenta existente.
 *  - No había ruta para desconectar.
 *
 * O sea que el único camino era entrar a la base a mano, para algo que un ADMIN
 * tiene que poder hacer desde su pantalla.
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
      credentialRef: 'ZAVU_API_KEY',
      webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
      ...(extra?.enviosReales ? { enviosReales: true } : {}),
    }),
  );
}

describe('reapuntar el emisor (#600)', () => {
  it('cambia el emisor de la cuenta y del número, sin crear otra cuenta', async () => {
    const { account } = await conectado('snd_de_prueba');

    const { number, account: despues } = await withTenant(admin, tenant, (c) =>
      reapuntarEmisor(c, {
        tenantId: tenant,
        accountId: account.id,
        senderId: 'snd_de_produccion',
        phoneNumberId: 'pn_nuevo',
      }),
    );

    // La MISMA cuenta: reapuntar no es conectar otra vez.
    expect(despues.id).toBe(account.id);
    expect(despues.config.senderId).toBe('snd_de_produccion');
    expect(number.senderId).toBe('snd_de_produccion');
    expect(number.phoneNumberId).toBe('pn_nuevo');

    // Y una sola cuenta de canal en el negocio: si hubiera creado otra, el
    // cupo del plan y la bandeja se partirían en dos.
    const cuentas = await admin.query(
      'SELECT count(*)::int AS n FROM channel_accounts WHERE tenant_id = $1',
      [tenant],
    );
    expect(cuentas.rows[0].n).toBe(1);
  });

  it('conserva `enviosReales`: la marca de que este canal manda de verdad', async () => {
    // Es la parte que más importa (#593). Esa marca es lo que hace visible que
    // un canal fuera de producción le escribe a clientes de verdad; pisarla al
    // reapuntar dejaría el riesgo sin la declaración que lo hace mirable.
    await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    const { account } = await conectado('snd_con_marca', { enviosReales: true });
    expect(account.config.enviosReales).toBe(true);

    const { account: despues } = await withTenant(admin, tenant, (c) =>
      reapuntarEmisor(c, { tenantId: tenant, accountId: account.id, senderId: 'snd_otro' }),
    );
    expect(despues.config.enviosReales, 'se perdió la marca de envíos reales').toBe(true);
  });

  it('no deja reapuntar una cuenta que no es de WhatsApp', async () => {
    const otra = (
      await admin.query(
        `INSERT INTO channel_accounts (tenant_id, kind, name, state, config)
         VALUES ($1, 'webchat', 'Chat del sitio', 'active', '{}'::jsonb) RETURNING id`,
        [tenant],
      )
    ).rows[0].id;
    await expect(
      withTenant(admin, tenant, (c) =>
        reapuntarEmisor(c, { tenantId: tenant, accountId: otra, senderId: 'snd_x' }),
      ),
    ).rejects.toThrow(/no es de WhatsApp/i);
    await admin.query('DELETE FROM channel_accounts WHERE id = $1', [otra]);
  });
});

describe('el emisor elegido tiene que servir para el canal (#600)', () => {
  // El mismo chequeo que al conectar, y por eso se reusa `elegirSender`: un
  // emisor cuyo `channels` no incluya este canal no manda nada, y la regla no
  // tiene por qué relajarse DESPUÉS de haber conectado.
  const conWhatsApp = { id: 'snd_wsp', name: 'El bueno', channels: ['whatsapp'] };
  const sinWhatsApp = { id: 'snd_ig', name: 'Solo Instagram', channels: ['instagram'] };

  it('acepta el que tiene el canal encendido', () => {
    const r = elegirSender([conWhatsApp, sinWhatsApp], 'whatsapp', 'snd_wsp');
    expect('sender' in r && r.sender.id).toBe('snd_wsp');
  });

  it('rechaza el que no, y dice cuáles sí sirven', () => {
    const r = elegirSender([conWhatsApp, sinWhatsApp], 'whatsapp', 'snd_ig');
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toMatch(/no existe o no tiene el canal whatsapp/i);
      // Los candidatos son los que SÍ sirven: sin eso, el mensaje manda a
      // adivinar cuál era.
      expect(r.candidatos.map((s) => s.id)).toEqual(['snd_wsp']);
    }
  });
});

describe('los emisores del proveedor (#600)', () => {
  const senders = [{ id: 'snd_1', channels: ['whatsapp'] }];

  it('acepta las tres formas de respuesta que usa la API', async () => {
    expect(await emisoresDelProveedor(async () => senders)).toEqual(senders);
    expect(await emisoresDelProveedor(async () => ({ items: senders }))).toEqual(senders);
    expect(await emisoresDelProveedor(async () => ({ data: senders }))).toEqual(senders);
  });

  it('con el proveedor caído devuelve null, que NO es «no hay ninguno»', async () => {
    // Confundir las dos cosas es lo que tenía el diagnóstico en verde mientras
    // no salía ni un mensaje (#591). Acá, además, una lista vacía mandaría a
    // conectar un emisor en Zavu cuando el problema es que no se pudo preguntar.
    const caido = await emisoresDelProveedor(async () => {
      throw new Error('ECONNREFUSED con la llave zv_live_… adentro');
    });
    expect(caido).toBeNull();
  });
});

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

  it('reapuntar NO reactiva un canal desconectado', async () => {
    // Reapuntar dice por dónde habla, no decide que vuelva a hablar. Si
    // reactivara de lado, una cuenta que alguien dio de baja volvería a mandar
    // sin que nadie lo haya decidido.
    await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    const { account } = await conectado('snd_de_baja');
    await withTenant(admin, tenant, (c) =>
      desconectarNumero(c, { tenantId: tenant, accountId: account.id }),
    );
    await withTenant(admin, tenant, (c) =>
      reapuntarEmisor(c, { tenantId: tenant, accountId: account.id, senderId: 'snd_nuevo' }),
    );
    const cuenta = await withTenant(admin, tenant, (c) =>
      getChannelAccount(c, tenant, account.id),
    );
    expect(cuenta.state).toBe('disconnected');
    expect(cuenta.config.senderId).toBe('snd_nuevo');
  });
});
