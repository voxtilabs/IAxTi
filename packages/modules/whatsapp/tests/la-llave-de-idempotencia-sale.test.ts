import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { registerProvider, resetProviders } from '@iaxti/module-channels';
import { createZernioProvider } from '../application/zernio';
import { deliverOutbound, esPermanente } from '../application/outbound';
import type { OutboundJobData } from '../application/outbound';

/**
 * La llave de idempotencia sale en la petición HTTP (#1273, #585).
 *
 * `deliverOutbound` armaba el mensaje campo por campo y se saltaba
 * `messageId`, así que el envío iba sin `Idempotency-Key`. Lo que eso cuesta:
 * si el proveedor acepta el mensaje y la respuesta se pierde —un timeout, la
 * red—, BullMQ reintenta y **el cliente recibe el mismo mensaje dos veces**.
 * Se paga dos veces y se gastan dos del tope diario.
 *
 * La prueba entra por `deliverOutbound` —el camino real del producto— y mira
 * la CABECERA de la petición HTTP. Con Zernio la llave es una cabecera
 * (`Idempotency-Key`) y no un campo del cuerpo, y la ruta del hilo la exige:
 * sin ella el adaptador no manda nada.
 *
 * Las dos cosas hacen falta, y lo comprobó la versión original equivocándose
 * primero: pruebas que llamaban a `provider.send` directo, con el `messageId`
 * puesto a mano, pasaban igual con el defecto. Claro: el agujero no estaba en
 * `send`, estaba en quien lo llama. Medir el argumento que uno mismo pasa no
 * prueba nada; es la versión de pruebas del `curl` que prohíbe
 * `.claude/rules/testing.md`.
 */
const original = globalThis.fetch;
beforeEach(() => {
  // El registro es estado de proceso: cada caso arma el suyo desde cero, como
  // lo hace el worker al arrancar, con el adaptador de Zernio registrado para
  // el par (proveedor, canal) que declara la cuenta.
  resetProviders();
  registerProvider(createZernioProvider('whatsapp'));
});
afterEach(() => {
  globalThis.fetch = original;
  vi.unstubAllEnvs();
  resetProviders();
});

/** Intercepta la salida y guarda las cabeceras del POST a la ruta del hilo. */
function interceptar(): { llaves: Array<string | undefined>; urls: string[] } {
  const llaves: Array<string | undefined> = [];
  const urls: string[] = [];
  globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
    const url = String(entrada);
    if (url.includes('/messages') && init?.method === 'POST') {
      urls.push(url);
      llaves.push(((init.headers ?? {}) as Record<string, string>)['idempotency-key']);
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, data: { messageId: `wamid_${randomUUID()}`, conversationId: 'hilo' } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { llaves, urls };
}

/** Lo mínimo que usa `checkNumberRateLimit`: contar y poner vencimiento. */
const redisFalso = () =>
  ({ incr: async () => 1, expire: async () => 1, pexpire: async () => 1, ttl: async () => 60 }) as unknown as IORedis;

const cuenta = {
  id: randomUUID(),
  tenantId: randomUUID(),
  kind: 'whatsapp' as const,
  name: 'WhatsApp de prueba',
  state: 'active' as const,
  provider: 'zernio' as const,
  credentialRef: 'ZERNIO_LLAVE_DE_PRUEBA',
  config: { zernioAccountId: `cuenta_zernio_${randomUUID().slice(0, 8)}` },
};

describe('la llave de idempotencia llega al proveedor (#1273)', () => {
  it('el envío lleva Idempotency-Key con NUESTRO id del mensaje', async () => {
    vi.stubEnv('ZERNIO_LLAVE_DE_PRUEBA', 'llave');
    const { llaves, urls } = interceptar();
    const nuestroId = randomUUID();

    await deliverOutbound(cuenta, {
      tenantId: cuenta.tenantId,
      channelAccountId: cuenta.id,
      messageId: nuestroId,
      to: '+56911112222',
      type: 'texto',
      body: 'Tu cotización',
      initiatedByBusiness: true,
      providerThreadId: 'hilo-1',
    }, redisFalso());

    expect(llaves).toHaveLength(1);
    expect(llaves[0]).toBe(nuestroId);
    // Y fue a la ruta del hilo, que es la que deduplica por esta llave.
    expect(urls[0]).toContain('/v1/inbox/conversations/hilo-1/messages');
  });

  /**
   * El caso que el campo evita, de frente: dos intentos del mismo mensaje
   * —que es lo que hace BullMQ cuando la respuesta se pierde— llevan la MISMA
   * llave, y por eso el proveedor puede reconocerlos.
   */
  it('dos intentos del mismo mensaje llevan la misma llave', async () => {
    vi.stubEnv('ZERNIO_LLAVE_DE_PRUEBA', 'llave');
    const { llaves } = interceptar();
    const nuestroId = randomUUID();
    const job = {
      tenantId: cuenta.tenantId,
      channelAccountId: cuenta.id,
      messageId: nuestroId,
      to: '+56911112222',
      type: 'texto',
      body: 'Tu cotización',
      initiatedByBusiness: true,
      providerThreadId: 'hilo-1',
    };

    await deliverOutbound(cuenta, job, redisFalso());
    await deliverOutbound(cuenta, job, redisFalso());

    expect(llaves).toHaveLength(2);
    expect(llaves[0]).toBe(llaves[1]);
    expect(llaves[0]).toBe(nuestroId);
  });

  /**
   * Y sin id, NADA sale: mandar una llave inventada —un random, la hora, o
   * una cadena vacía que el proveedor podría tratar como compartida— es peor
   * que no mandar, porque un reintento con otra llave duplica el mensaje que
   * la llave existía para evitar.
   *
   * El TIPO de `OutboundJobData` exige el `messageId`, y este casteo no lo
   * invalida: los jobs llegan deserializados de Redis, donde el tipo es una
   * promesa y no un chequeo. El que cuida la frontera en tiempo de ejecución
   * es el adaptador, y esto comprueba que sigue ahí.
   */
  it('sin id, el envío no se hace: mejor no mandar que duplicar', async () => {
    vi.stubEnv('ZERNIO_LLAVE_DE_PRUEBA', 'llave');
    const { llaves } = interceptar();

    const error = await deliverOutbound(cuenta, {
      tenantId: cuenta.tenantId,
      channelAccountId: cuenta.id,
      to: '+56911112222',
      type: 'texto',
      body: 'sin id',
      initiatedByBusiness: true,
      providerThreadId: 'hilo-1',
    } as OutboundJobData, redisFalso()).catch((e: unknown) => e);

    expect(llaves).toHaveLength(0);
    expect(esPermanente(error)).toBe(true);
  });
});
