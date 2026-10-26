import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * Un webhook entrante con la base caída (#361).
 *
 * Dos webhooks respondieron 500 y los mensajes se perdieron: fueron los
 * primeros dos minutos después de un redespliegue. Un 500 le dice al
 * proveedor "me rompí" y cada proveedor decide solo si reintenta.
 *
 * Este test apunta la API a un puerto donde no hay nadie —el peor caso, la
 * base que nunca responde— y exige que la respuesta sea algo que el
 * proveedor SÍ sabe reintentar. Va en su propio archivo porque cambia
 * `DATABASE_URL` del proceso: el pool de la API se crea una vez y queda.
 */
let app: INestApplication;
let base: string;
let muerto: Pool;

beforeAll(async () => {
  const { createPool } = await import('@iaxti/db');
  const { usarPool } = await import('../src/db');
  const { createApp } = await import('../src/main');
  // Un pool hacia un puerto donde no hay nadie, INYECTADO: cambiar
  // `process.env.DATABASE_URL` le cambiaría la base a los otros archivos de
  // test, que corren en hilos del mismo proceso.
  muerto = createPool('postgres://nadie:nadie@127.0.0.1:59999/no_existe');
  usarPool(muerto);
  app = await createApp({ jwtVerify: async () => ({ userId: 'nadie' }) });
  await app.listen(0);
  base = urlDeLaApp(app);
  /**
   * Treinta segundos, y el número está medido (#1005).
   *
   * Este hook levanta la aplicación Nest ENTERA —`createApp` y `listen`—
   * porque este archivo necesita su propia instancia: inyecta un pool hacia un
   * puerto donde no hay nadie, y eso no se puede hacer compartiendo la app con
   * los otros archivos.
   *
   * Aislado, el archivo completo tarda ~5,5 s y las dos pruebas se llevan
   * 4,4 s. Bajo el preflight —todos los paquetes en paralelo— ese arranque se
   * pasa de los 10 s que vitest da por defecto a un hook, y el archivo se cae
   * sin que ninguna aserción falle:
   *
   *     Error: Hook timed out in 10000ms.
   *
   * El tope largo es para que la prueba mida lo que dice medir y no el estado
   * de la máquina. Misma familia que #986 y #995.
   */
}, 30_000);

afterAll(async () => {
  const { usarPool } = await import('../src/db');
  usarPool(null);
  /**
   * `app?.` y no `app.`: si el hook de arriba no llegó a crear la app, esto
   * lanzaba `Cannot read properties of undefined (reading 'close')` y el log
   * terminaba con un error de LIMPIEZA que no dice nada del motivo real.
   *
   * Es la lección del `finally` de #991 por otra puerta: la limpieza no puede
   * sumar un error propio cuando lo que falló es otra cosa. Lo que se lee
   * tiene que ser por qué se cayó, no en qué se tropezó al salir.
   */
  await app?.close();
  await muerto?.end().catch(() => undefined);
});

describe('webhook con la base sin responder', () => {
  it('responde 503 con Retry-After, no 500', async () => {
    const cuerpo = JSON.stringify({ mensajes: [] });
    const res = await fetch(`${base}/webhooks/channels/${crypto.randomUUID()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Iaxti-Signature': createHmac('sha256', 'lo-que-sea').update(cuerpo).digest('hex'),
      },
      body: cuerpo,
    });

    // 500 sería "me rompí": el proveedor decide solo si vuelve.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(503);
    // Lo que convierte el 503 en una promesa y no en un adiós.
    expect(res.headers.get('retry-after')).toBe('5');

    const cuerpoRes = await res.json();
    expect(cuerpoRes.code).toBe('BASE_NO_RESPONDE');
    // Un proveedor no lee español, pero una persona mirando los logs sí.
    expect(cuerpoRes.message).toContain('Reintenta');
  });

  it('nunca responde 2xx si no pudo guardar nada', async () => {
    // Es la regla de fondo: un 200 es una promesa de que el mensaje está.
    const cuerpo = JSON.stringify({ mensajes: [{ id: 'x' }] });
    const res = await fetch(`${base}/webhooks/channels/${crypto.randomUUID()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cuerpo,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
