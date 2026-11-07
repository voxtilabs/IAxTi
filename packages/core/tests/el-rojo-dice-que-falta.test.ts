import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { exigirServicio, exigirVariables } from '../src/testing/servicios';

/**
 * Un rojo que dice qué falta, en vez de agotar el reloj (#1254).
 *
 * Medido el 7 de noviembre, con el contenedor de Redis caído desde hacía trece
 * horas: `apagado-ordenado` fallaba con «Test timed out in 20000ms» y el
 * mensaje no mencionaba Redis en ninguna parte. Estuve a punto de atribuirlo a
 * mi cambio y buscar una regresión que no existía.
 *
 * Y es peor que perder tiempo: un rojo que no habla del cambio enseña a
 * ignorar el rojo, que es lo que esta issue vino a evitar.
 */
let escuchando: Server;
let puerto: number;

beforeAll(async () => {
  escuchando = createServer();
  await new Promise<void>((r) => escuchando.listen(0, '127.0.0.1', r));
  puerto = (escuchando.address() as { port: number }).port;
});

afterAll(async () => {
  if (!escuchando) return;
  await new Promise<void>((r) => escuchando.close(() => r()));
});

describe('el rojo dice qué falta (#1254)', () => {
  it('con el servicio arriba, no dice nada', async () => {
    await expect(exigirServicio(`redis://127.0.0.1:${puerto}/1`, 'Redis')).resolves.toBeUndefined();
  });

  it('sin el servicio, nombra el servicio, dónde lo buscó y cómo levantarlo', async () => {
    // Un puerto que nadie escucha: el error llega en milisegundos, no en los
    // veinte segundos del timeout.
    const error = await exigirServicio('redis://127.0.0.1:6399/1', 'Redis').catch(
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const texto = (error as Error).message;
    expect(texto, 'tiene que nombrar el servicio').toContain('Redis');
    expect(texto, 'y dónde lo buscó').toContain('127.0.0.1:6399');
    expect(texto, 'y qué hacer').toContain('docker start lino-redis-1');
  });

  it('un servicio que acepta la conexión y no contesta se corta por plazo, no se cuelga', async () => {
    // El caso que un `ioredis` esconde: conecta, reintenta solo y deja la
    // suite esperando. Acá se mide contra una dirección no enrutable.
    const empezo = Date.now();
    const error = await exigirServicio('redis://192.0.2.1:6379/1', 'Redis', 300).catch(
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    // Holgado a propósito: lo que se fija es que corta, no cuánto tarda la red.
    expect(Date.now() - empezo).toBeLessThan(3_000);
  });

  it('exigirVariables nombra las que faltan, y solo esas', () => {
    expect(() => exigirVariables(['HAY', 'FALTA_UNA'], { HAY: 'sí' })).toThrow(/FALTA_UNA/);
    expect(() => exigirVariables(['HAY', 'FALTA_UNA'], { HAY: 'sí' })).not.toThrow(/HAY,/);
    expect(() => exigirVariables(['A', 'B'], {})).toThrow(/A, B/);
    expect(() => exigirVariables(['HAY'], { HAY: 'sí' })).not.toThrow();
  });

  it('y dice cómo correr la suite bien, no solo que falta algo', () => {
    expect(() => exigirVariables(['REDIS_URL'], {})).toThrow(/antes-de-empujar\.sh/);
  });
});
