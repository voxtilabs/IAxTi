import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { registerProvider, getProvider } from '@iaxti/module-channels';
import { createZavuProvider } from '../application/zavu';
import { deliverOutbound } from '../application/outbound';

/**
 * La llave de idempotencia sale en el cuerpo HTTP (#1273).
 *
 * `deliverOutbound` armaba el mensaje campo por campo y se saltaba
 * `messageId`, así que el POST a Zavu iba sin `idempotencyKey`. Lo que eso
 * cuesta lo dice el comentario de `zavu.ts` en quince líneas: si Zavu acepta
 * el mensaje y la respuesta se pierde —un timeout, la red—, BullMQ reintenta
 * y **el cliente recibe el mismo mensaje dos veces**. Se paga dos veces y se
 * gastan dos del tope diario.
 *
 * La prueba entra por `deliverOutbound` —el camino real del producto— y mira
 * el CUERPO de la petición HTTP.
 *
 * Las dos cosas hacen falta, y lo comprobé equivocándome primero: escribí
 * estas pruebas llamando a `provider.send` directo, con el `messageId` puesto
 * a mano, y **pasaban igual con el defecto**. Claro: el agujero no estaba en
 * `send`, estaba en quien lo llama. Medir el argumento que yo mismo paso no
 * prueba nada; es la versión de pruebas del `curl` que prohíbe
 * `.claude/rules/testing.md`.
 */
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.unstubAllEnvs();
});

/** Intercepta la salida y devuelve el cuerpo del POST a `/messages`. */
function interceptar(): { cuerpos: Record<string, unknown>[] } {
  const cuerpos: Record<string, unknown>[] = [];
  globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
    if (String(entrada).endsWith('/messages') && init?.method === 'POST') {
      cuerpos.push(JSON.parse(String(init.body)));
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { id: `zv_${randomUUID().replaceAll('-', '')}` } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { cuerpos };
}

/** Lo mínimo que usa `checkNumberRateLimit`: contar y poner vencimiento. */
const redisFalso = () =>
  ({ incr: async () => 1, expire: async () => 1, pexpire: async () => 1, ttl: async () => 60 }) as unknown as IORedis;

const cuenta = {
  id: randomUUID(),
  tenantId: randomUUID(),
  kind: 'whatsapp' as const,
  credentialRef: 'ZAVU_LLAVE_DE_PRUEBA',
  config: { senderId: 'snd_prueba' },
};

if (!getProvider("whatsapp")) registerProvider(createZavuProvider());

describe('la llave de idempotencia llega al proveedor (#1273)', () => {
  it('el POST lleva idempotencyKey con NUESTRO id del mensaje', async () => {
    vi.stubEnv('ZAVU_LLAVE_DE_PRUEBA', 'llave');
    const { cuerpos } = interceptar();
    const nuestroId = randomUUID();

    await deliverOutbound(
      cuenta as never,
      { messageId: nuestroId, to: '+56911112222', type: 'texto', body: 'Tu cotización' } as never,
      redisFalso(),
    );

    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].idempotencyKey).toBe(nuestroId);
  });

  /**
   * El caso que el campo evita, de frente: dos intentos del mismo mensaje
   * —que es lo que hace BullMQ cuando la respuesta se pierde— llevan la MISMA
   * llave, y por eso el proveedor puede reconocerlos.
   */
  it('dos intentos del mismo mensaje llevan la misma llave', async () => {
    vi.stubEnv('ZAVU_LLAVE_DE_PRUEBA', 'llave');
    const { cuerpos } = interceptar();
    const nuestroId = randomUUID();
    const job = { messageId: nuestroId, to: '+56911112222', type: 'texto', body: 'Tu cotización' };

    await deliverOutbound(cuenta as never, job as never, redisFalso());
    await deliverOutbound(cuenta as never, job as never, redisFalso());

    expect(cuerpos).toHaveLength(2);
    expect(cuerpos[0].idempotencyKey).toBe(cuerpos[1].idempotencyKey);
    expect(cuerpos[0].idempotencyKey).toBe(nuestroId);
  });

  /**
   * Y sin id, el campo NO viaja vacío: mandar `idempotencyKey: undefined` o
   * una cadena vacía es peor que no mandarlo, porque el proveedor podría
   * tratarla como una llave real compartida por todos.
   */
  it('sin id, el campo no viaja con un valor inventado', async () => {
    vi.stubEnv('ZAVU_LLAVE_DE_PRUEBA', 'llave');
    const { cuerpos } = interceptar();
    await deliverOutbound(
      cuenta as never,
      { messageId: undefined, to: '+56911112222', type: 'texto', body: 'sin id' } as never,
      redisFalso(),
    );
    const llave = cuerpos[0].idempotencyKey;
    expect(llave === undefined || llave === null).toBe(true);
  });
});
