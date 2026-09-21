import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { consumerReadiness } from '../src/consumer-readiness';

const configured = { REDIS_URL: process.env.REDIS_URL, DATABASE_URL: process.env.DATABASE_URL };
let blackhole: Server;
let port: number;
const sockets = new Set<Socket>();
beforeAll(async () => {
  expect(configured.REDIS_URL).toBeTruthy();
  expect(configured.DATABASE_URL).toBeTruthy();
  blackhole = createServer(socket => {
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => blackhole.listen(0, '127.0.0.1', resolve));
  port = (blackhole.address() as { port: number }).port;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => blackhole.close(() => resolve()));
});

describe('disponibilidad real de los consumidores (#17)', () => {
  it('workers necesita Redis y PostgreSQL reales', async () => {
    const result = await consumerReadiness('workers', configured);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ status: 'ok', redis: 'ok', database: 'ok', startup: 'ok' });
  });

  it('agents comprueba Redis sin exigir una base que no utiliza', async () => {
    const result = await consumerReadiness('agents', { REDIS_URL: configured.REDIS_URL });
    expect(result.statusCode).toBe(200);
    expect(result.body.redis).toBe('ok');
    expect(result.body).not.toHaveProperty('database');
  });

  it.each(['workers', 'agents'] as const)('%s sin Redis responde 503', async service => {
    const result = await consumerReadiness(service, { ...configured, REDIS_URL: undefined });
    expect(result.statusCode).toBe(503);
    expect(result.body.redis).toBe('sin configurar');
  });

  it('workers sin base responde 503', async () => {
    const result = await consumerReadiness('workers', { REDIS_URL: configured.REDIS_URL });
    expect(result.statusCode).toBe(503);
    expect(result.body.database).toBe('sin configurar');
  });

  it('dependencias sanas no ocultan un arranque sin terminar', async () => {
    const result = await consumerReadiness('workers', configured, 2_000, false);
    expect(result.statusCode).toBe(503);
    expect(result.body.startup).toBe('iniciando');
  });

  it.each(['redis', 'database'] as const)('%s que rechaza la conexión no filtra credenciales ni el host', async kind => {
    const url = kind === 'redis' ? 'redis://:clave-de-prueba@127.0.0.1:1' : 'postgres://probe:clave-de-prueba@127.0.0.1:1/db';
    const result = await consumerReadiness('workers', { ...configured, [kind === 'redis' ? 'REDIS_URL' : 'DATABASE_URL']: url });
    expect(result.statusCode).toBe(503);
    expect(result.body[kind]).toBe('no disponible');
    expect(JSON.stringify(result)).not.toMatch(/clave-de-prueba|127\.0\.0\.1|ECONN/);
  });

  it.each(['redis', 'database'] as const)('%s que acepta TCP pero no contesta vence el plazo y cierra su conexión', async kind => {
    const url = kind === 'redis' ? `redis://127.0.0.1:${port}` : `postgres://probe:clave@127.0.0.1:${port}/db`;
    const started = Date.now();
    const result = await consumerReadiness('workers', { ...configured, [kind === 'redis' ? 'REDIS_URL' : 'DATABASE_URL']: url }, 100);
    expect(result.statusCode).toBe(503);
    expect(result.body[kind]).toBe('no respondió a tiempo');
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sockets.size).toBe(0);
    expect((await consumerReadiness('workers', configured)).statusCode).toBe(200);
  });

  it('rechaza URLs inválidas y protocolos ajenos sin publicar su contenido', async () => {
    const result = await consumerReadiness('workers', { REDIS_URL: 'https://valor-privado', DATABASE_URL: 'valor-privado' });
    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({ redis: 'no disponible', database: 'no disponible' });
    expect(JSON.stringify(result)).not.toContain('valor-privado');
  });
});
