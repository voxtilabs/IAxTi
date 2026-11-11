import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { sendMessage } from '@iaxti/module-conversations';
import type { OutboundJobData } from '@iaxti/module-whatsapp';
import { ErrorPermanente } from '@iaxti/module-whatsapp';
import {
  createChannelAccount,
  registerProvider,
  resetProviders,
  setChannelState,
} from '@iaxti/module-channels';
import type { ChannelProvider } from '@iaxti/module-channels';
import { processOutbound } from '../src/outbound';
import { processInbound, type InboundJob } from '../src/inbound';

/**
 * La respuesta sale dentro del hilo del proveedor (ADR-0033, #1334).
 *
 * Entra por los CAMINOS REALES del worker —`processInbound` y
 * `processOutbound`, con Postgres y Redis de verdad— y lo único falso es el
 * adaptador, registrado para un proveedor de prueba. Lo que eso mide, y lo
 * que no:
 *
 *  · SÍ: que lo que entra recuerda el hilo y el saliente siguiente viaja con
 *    él; que un saliente sin hilo que abre conversación deja la nueva
 *    recordada; que `hilo_vencido` se olvida y se reintenta UNA vez sin hilo,
 *    y que si ese reintento también falla no hay tercero; que DOS salientes
 *    simultáneos al mismo contacto sin hilo conocido abren UNA sola
 *    conversación.
 *  · NO: `recordarHilo`/`hiloDe` y el candado en sí —los prueba
 *    `el-hilo-del-proveedor.test.ts` en el módulo channels, con dos
 *    conexiones y FK compuesta.
 *  · NO: el adaptador de Zernio de verdad —lo que acá se mide es la MITAD
 *    DEL WORKER, que lee el hilo de la tabla, lo pone en el mensaje y
 *    recuerda el que devuelve el adaptador; cualquier adaptador que respete
 *    el puerto hace el mismo papel.
 */

/** La base de pruebas del monorepo: NUNCA el 5432, que es de otro proyecto. */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5433/iaxti_pruebas';

let admin: Pool;
let redis: IORedis;
let tenant: string;
let cuentaZernio: string;
let cuentaZavu: string;

/** Lo que le llegó al adaptador, en orden. */
const registros: Array<Parameters<ChannelProvider['send']>[1]> = [];
let n = 0;
/** Qué hace el adaptador de Zernio con el próximo envío. */
let modo: 'ok' | 'vencido' | 'vencidoYRechaza' | 'unico' = 'ok';
/**
 * Cuántas conversaciones abrió el adaptador en el modo `unico`. Crear una en
 * Zernio no acepta Idempotency-Key: cada llamada sin hilo que llegue abre una
 * de verdad, y este contador es lo que la prueba lee para notarlo.
 */
let creadas = 0;

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const zernioFalso: ChannelProvider = {
  kind: 'whatsapp',
  proveedor: 'zernio',
  async send(_cuenta, message) {
    registros.push(structuredClone(message));
    n += 1;
    if (message.providerThreadId) {
      if (modo === 'vencido' || modo === 'vencidoYRechaza') {
        // El 404 del envío dentro de una conversación que ya no está, tal
        // como lo clasifica el adaptador real: el marcador va PRIMERO en el
        // detalle, que es lo que el worker mira.
        throw new ErrorPermanente(
          'La conversación de este contacto ya no existe en el proveedor.',
          `hilo_vencido: Zernio HTTP 404 {"error":"conversation not found"}`,
        );
      }
      return { providerMessageId: `zr-${n}`, providerThreadId: message.providerThreadId };
    }
    if (modo === 'vencidoYRechaza') {
      // El reintento sin hilo también falla, pero por OTRA cosa: eso es lo
      // que decide que no haya tercero.
      throw new ErrorPermanente(
        'El proveedor rechazó este envío y reintentarlo no lo va a cambiar.',
        'Zernio HTTP 400 code=TEMPLATE_REQUIRED',
      );
    }
    if (modo === 'unico') {
      // Sin hilo: el adaptador abre una conversación en Zernio —que no
      // acepta Idempotency-Key en ese endpoint— y tarda un poquito en
      // contestar. Esa espera es la ventana de la carrera: si el otro envío
      // al mismo contacto llega mientras esta abre, abre OTRA.
      //
      // El id se captura ANTES de esperar: leído después del `await`
      // alcanzaría el `n` que la otra llamada ya incrementó, y las dos
      // abrirían con el MISMO id de mensaje del proveedor.
      creadas += 1;
      const providerMessageId = `zr-${n}`;
      await esperar(300);
      return { providerMessageId, providerThreadId: 'hilo-unico' };
    }
    // Sin hilo: el adaptador abre la conversación y devuelve el hilo nuevo
    // para que el worker lo recuerde.
    return { providerMessageId: `zr-${n}`, providerThreadId: `hilo-abierto-${n}` };
  },
  verifyWebhook: () => true,
  normalize: () => [],
};

/**
 * El de Zavu: sin `proveedor`, así que cae al POR OMISIÓN — mismo registro al
 * que resuelve una cuenta que no declara proveedor. Y no devuelve ningún
 * hilo: Zavu manda por destinatario y no conoce el concepto.
 */
const zavuFalso: ChannelProvider = {
  kind: 'whatsapp',
  async send(_cuenta, message) {
    registros.push(structuredClone(message));
    n += 1;
    return { providerMessageId: `wamid.zv-${n}` };
  },
  verifyWebhook: () => true,
  normalize: () => [],
};

/** El hilo que la tabla tiene para (cuenta, peer), leído crudo de la base. */
async function hiloGuardado(cuenta: string, peer: string): Promise<string | null> {
  return withTenant(admin, tenant, async (c) => {
    const r = await c.query(
      `SELECT provider_thread_id FROM channel_threads
        WHERE tenant_id = $1 AND channel_account_id = $2 AND peer = $3`,
      [tenant, cuenta, peer],
    );
    return r.rows[0]?.provider_thread_id ?? null;
  });
}

/** Un entrante del cliente, por el camino real de la cola inbound. */
async function entraUnMensaje(cuenta: string, phone: string, hilo?: string) {
  return processInbound(admin, {
    moduleId: 'conversations',
    tenantId: tenant,
    phone,
    channel: 'whatsapp',
    channelAccountId: cuenta,
    type: 'texto',
    body: 'hola, tengo una duda',
    providerMessageId: `pm-${cuenta.slice(0, 8)}-${phone.slice(-4)}-${n}`,
    ...(hilo ? { providerThreadId: hilo } : {}),
  } as InboundJob);
}

/** Una respuesta manual en esa conversación, lista para despachar. */
async function saleUnaRespuesta(conversationId: string): Promise<string> {
  const m = await withTenant(admin, tenant, (c) =>
    sendMessage(c, { tenantId: tenant, conversationId, authorKind: 'user', body: 'claro, te cuento' }),
  );
  return m.id;
}

function jobPara(messageId: string, cuenta: string) {
  return {
    attemptsMade: 0,
    opts: { attempts: 5 },
    data: {
      moduleId: 'whatsapp' as const,
      tenantId: tenant,
      messageId,
      channelAccountId: cuenta,
      to: '',
      initiatedByBusiness: false,
    } satisfies OutboundJobData,
  };
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  redis = redisConnection();
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name) VALUES ('la-respuesta-sale-en-su-hilo') RETURNING id",
  );
  tenant = t.rows[0].id;

  resetProviders();
  registerProvider(zernioFalso);
  registerProvider(zavuFalso);

  cuentaZernio = (
    await withTenant(admin, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'Zernio del hilo',
        config: { phoneNumberId: 'pn-hilo-zernio' },
      }),
    )
  ).id;
  // `createChannelAccount` no declara proveedor: pasa a Zernio por SQL, que es
  // el mismo camino que usa `el-proveedor-es-de-la-cuenta.test.ts` — migrar
  // la cuenta es SQL hoy.
  await admin.query('UPDATE channel_accounts SET provider = $2 WHERE id = $1', [
    cuentaZernio,
    'zernio',
  ]);
  cuentaZavu = (
    await withTenant(admin, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'Zavu del hilo',
        config: { phoneNumberId: 'pn-hilo-zavu' },
      }),
    )
  ).id;
  await withTenant(admin, tenant, (c) =>
    setChannelState(c, { tenantId: tenant, accountId: cuentaZernio, state: 'active' }),
  );
  await withTenant(admin, tenant, (c) =>
    setChannelState(c, { tenantId: tenant, accountId: cuentaZavu, state: 'active' }),
  );
}, 120_000);

beforeEach(() => {
  modo = 'ok';
  registros.length = 0;
  creadas = 0;
});

afterAll(async () => {
  resetProviders();
  await redis?.quit();
  if (tenant) {
    await admin.query('DELETE FROM channel_threads WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contact_identities WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
    // `audit_log` es append-only por trigger: sin `sinTriggers` esto revienta.
    await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
    await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  }
  await admin?.end();
});

describe('la respuesta sale en su hilo (#1334)', () => {
  it('lo que entra recuerda el hilo; el saliente siguiente viaja dentro de él', async () => {
    const PEER = '+56955551501';
    const r = await entraUnMensaje(cuentaZernio, PEER, 'hilo-1');
    // El camino de ENTRADA lo dejó en la tabla, en la misma transacción.
    expect(await hiloGuardado(cuentaZernio, PEER)).toBe('hilo-1');

    const messageId = await saleUnaRespuesta(r.conversationId);
    const res = await processOutbound(admin, redis, jobPara(messageId, cuentaZernio));
    expect(res.providerMessageId).toMatch(/^zr-/);
    expect(registros).toHaveLength(1);
    // La respuesta no pidió abrir conversación: viajó dentro de la que el
    // cliente ya tenía abierta, con el hilo que aprendimos de su mensaje.
    expect(registros[0].providerThreadId).toBe('hilo-1');
    const fila = await admin.query('SELECT delivery_status FROM messages WHERE id = $1', [messageId]);
    expect(fila.rows[0].delivery_status).toBe('sent');
  });

  it('un saliente sin hilo que abre conversación deja la nueva recordada', async () => {
    const PEER = '+56955551502';
    // Este contacto escribió por una cuenta que no reporta hilos (Zavu):
    // no hay nada en la tabla.
    const r = await entraUnMensaje(cuentaZernio, PEER);
    expect(await hiloGuardado(cuentaZernio, PEER)).toBeNull();

    const primero = await saleUnaRespuesta(r.conversationId);
    const res = await processOutbound(admin, redis, jobPara(primero, cuentaZernio));
    expect(res.providerMessageId).toMatch(/^zr-/);
    expect(registros).toHaveLength(1);
    expect(registros[0].providerThreadId, 'el primero salió sin hilo conocido').toBeUndefined();
    // El adaptador abrió la conversación y el worker la recordó.
    const hiloNuevo = await hiloGuardado(cuentaZernio, PEER);
    expect(hiloNuevo).toMatch(/^hilo-abierto-/);

    // Y el envío SIGUIENTE al mismo contacto ya viaja dentro de ella: esa
    // es la parte que de nada serviría si solo el adaptador lo supiera.
    const segundo = await saleUnaRespuesta(r.conversationId);
    await processOutbound(admin, redis, jobPara(segundo, cuentaZernio));
    expect(registros).toHaveLength(2);
    expect(registros[1].providerThreadId).toBe(hiloNuevo);
  });

  it('hilo_vencido: se olvida y se reintenta UNA vez sin hilo, y esa sale bien', async () => {
    const PEER = '+56955551503';
    const r = await entraUnMensaje(cuentaZernio, PEER, 'hilo-3');
    const messageId = await saleUnaRespuesta(r.conversationId);

    modo = 'vencido';
    const res = await processOutbound(admin, redis, jobPara(messageId, cuentaZernio));
    expect(res.providerMessageId).toMatch(/^zr-/);
    // Dos llamadas y no más: la primera con el hilo vencido, la segunda SIN
    // hilo, que es el reintento.
    expect(registros).toHaveLength(2);
    expect(registros[0].providerThreadId).toBe('hilo-3');
    expect(registros[1].providerThreadId, 'el reintento viaja sin hilo').toBeUndefined();
    // El mensaje se entregó en el reintento, no quedó dando vueltas.
    const fila = await admin.query('SELECT delivery_status FROM messages WHERE id = $1', [messageId]);
    expect(fila.rows[0].delivery_status).toBe('sent');
  });

  it('si el reintento sin hilo también falla, no hay tercero', async () => {
    const PEER = '+56955551504';
    const r = await entraUnMensaje(cuentaZernio, PEER, 'hilo-4');
    const messageId = await saleUnaRespuesta(r.conversationId);

    modo = 'vencidoYRechaza';
    const res = await processOutbound(admin, redis, jobPara(messageId, cuentaZernio));
    // Una sola reintentada y se rechaza YA con la causa legible: si volviera
    // a fallar y se reencolara, el mensaje se quedaba «enviando» horas y lo
    // que contaba era el texto crudo del sistema (#556).
    expect(registros, 'primera con hilo, reintento sin hilo, y NADA más').toHaveLength(2);
    expect(res.failed).toMatch(/rechazó este envío/);
    const fila = await admin.query('SELECT delivery_status FROM messages WHERE id = $1', [messageId]);
    expect(fila.rows[0].delivery_status).toBe('failed');
    // Y el hilo vencido quedó olvidado: el próximo mensaje a este contacto
    // arranca sin él en vez de chocar con el mismo 404 para siempre.
    expect(await hiloGuardado(cuentaZernio, PEER)).toBeNull();
  });

  it('dos salientes simultáneos al mismo contacto sin hilo conocido: UNA sola conversación', async () => {
    const PEER = '+56955551506';
    // Este contacto escribió y la cuenta no reportó hilo: la tabla no tiene
    // nada para (cuenta, peer), así que ambos envíos llegan «sin hilo».
    const r = await entraUnMensaje(cuentaZernio, PEER);
    expect(await hiloGuardado(cuentaZernio, PEER)).toBeNull();

    const uno = await saleUnaRespuesta(r.conversationId);
    const dos = await saleUnaRespuesta(r.conversationId);

    modo = 'unico';
    /*
     * Dos jobs del worker, como los despacha BullMQ de verdad: cada
     * `processOutbound` toma SU conexión del pool (`withTenant` hace
     * `pool.connect()`) y corre en su propia transacción. `Promise.all`
     * los deja a los dos en la base al mismo tiempo.
     *
     * El candado por destinatario es lo único que evita que los dos
     * abran conversación: `getOutboundContext` bloquea con FOR UPDATE
     * solo la fila del MENSAJE propio —dos mensajes distintos, dos
     * filas—, así que sin el candado ambas transacciones leen «sin
     * hilo» y ambas llegan al adaptador sin `providerThreadId`.
     */
    const [resUno, resDos] = await Promise.all([
      processOutbound(admin, redis, jobPara(uno, cuentaZernio)),
      processOutbound(admin, redis, jobPara(dos, cuentaZernio)),
    ]);
    expect(resUno.providerMessageId).toMatch(/^zr-/);
    expect(resDos.providerMessageId).toMatch(/^zr-/);
    expect(registros).toHaveLength(2);

    // Uno abrió la conversación; el otro viajó dentro de ella. No al revés
    // ni dos veces: el adaptador cuenta las que abre.
    expect(creadas, 'sin el candado serían dos, una por cada envío').toBe(1);
    const conHilo = registros.filter((m) => m.providerThreadId);
    expect(conHilo).toHaveLength(1);
    expect(conHilo[0].providerThreadId).toBe('hilo-unico');
    // Y el hilo que quedó en la tabla es el de la ÚNICA conversación.
    expect(await hiloGuardado(cuentaZernio, PEER)).toBe('hilo-unico');
  });

  it('zavu, el proveedor por omisión, sigue mandando igual que antes', async () => {
    const PEER = '+56955551505';
    // La cuenta no declara proveedor: resuelve al POR OMISIÓN, que es Zavu.
    const r = await entraUnMensaje(cuentaZavu, PEER);
    const messageId = await saleUnaRespuesta(r.conversationId);

    const res = await processOutbound(admin, redis, jobPara(messageId, cuentaZavu));
    expect(res.providerMessageId).toMatch(/^wamid\.zv-/);
    expect(registros).toHaveLength(1);
    // Zavu manda por destinatario: ni lleva hilo ni abre conversación.
    expect(registros[0].providerThreadId).toBeUndefined();
    expect(await hiloGuardado(cuentaZavu, PEER)).toBeNull();
    const fila = await admin.query('SELECT delivery_status FROM messages WHERE id = $1', [messageId]);
    expect(fila.rows[0].delivery_status).toBe('sent');
  });
});