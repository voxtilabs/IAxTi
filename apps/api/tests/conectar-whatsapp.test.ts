import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { urlDeLaApp } from './url-de-la-app';

/**
 * Las rutas de «Conectar WhatsApp» desde la app (#1393).
 *
 * El alta en sí se prueba en el módulo, contra la base y la custodia de
 * verdad. Acá va lo que es de la API: que el guard la cierre, que sin
 * configuración responda con el formato único y sin decir qué variable
 * falta, y que las tres rutas existan en el contrato.
 */
let app: INestApplication;
let base: string;
const respaldo = { ZERNIO_API_KEY: process.env.ZERNIO_API_KEY, API_URL_PUBLIC: process.env.API_URL_PUBLIC };

beforeAll(async () => {
  delete process.env.ZERNIO_API_KEY;
  app = await createApp();
  await app.listen(0);
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app.close();
  for (const [k, v] of Object.entries(respaldo)) if (v !== undefined) process.env[k] = v;
});

const identidad = (role: string) => ({
  'X-User-Id': 'u-1393',
  'X-Tenant-Id': '00000000-0000-4000-8000-000000001393',
  'X-Role': role,
  'content-type': 'application/json',
});

const RUTAS = [
  ['POST', '/v1/channels/whatsapp/enlace', undefined],
  ['GET', '/v1/channels/whatsapp/numeros', undefined],
  ['POST', '/v1/channels/whatsapp/conectar', JSON.stringify({ cuenta: 'acc_1393' })],
] as const;

describe('conectar WhatsApp desde la app: la API', () => {
  it('quien no administra canales recibe 403 con el formato único', async () => {
    for (const [method, ruta, body] of RUTAS) {
      const res = await fetch(`${base}${ruta}`, { method, headers: identidad('USER'), ...(body ? { body } : {}) });
      expect(res.status, `${method} ${ruta}`).toBe(403);
      const cuerpo = await res.json();
      expect(cuerpo.code).toBe('PERMISSION_DENIED');
      expect(cuerpo.requestId).toMatch(/^req_/);
    }
  });

  it('sin la llave del operador responde 503 y no nombra variables ni secretos', async () => {
    // Con el cuerpo válido: sin modo el 400 de validación llega primero
    // (el pipe de `@Cuerpo` corre antes que el método) y el 503 no se prueba.
    const res = await fetch(`${base}/v1/channels/whatsapp/enlace`, {
      method: 'POST',
      headers: identidad('ADMIN'),
      body: JSON.stringify({ modo: 'coexistencia' }),
    });
    expect(res.status).toBe(503);
    const cuerpo = await res.json();
    expect(cuerpo.code).toBe('WHATSAPP_CONNECT_UNAVAILABLE');
    expect(cuerpo.message).not.toMatch(/ZERNIO|API_URL|GOOGLE_SECRET/);
  });

  it('el enlace sin modo es 400, antes de mirar la configuración', async () => {
    // Acá tampoco está la llave del operador: si el 400 llega igual, la
    // validación del cuerpo corrió antes que `dependencias()` — el pipe de
    // `@Cuerpo` es de parámetro y Nest lo corre antes de entrar al método.
    for (const cuerpo of [JSON.stringify({}), JSON.stringify({ modo: 'en la app' })]) {
      const res = await fetch(`${base}/v1/channels/whatsapp/enlace`, {
        method: 'POST',
        headers: identidad('ADMIN'),
        body: cuerpo,
      });
      expect(res.status, cuerpo).toBe(400);
      expect((await res.json()).message).toBe(
        'Elige cómo usas hoy ese número: en la app WhatsApp Business del teléfono, o solo para IAxTi.',
      );
    }
  });

  it('conectar sin elegir número es 400, antes de tocar nada', async () => {
    const res = await fetch(`${base}/v1/channels/whatsapp/conectar`, {
      method: 'POST',
      headers: identidad('ADMIN'),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/Elige el número/);
  });

  it('las tres rutas están en el OpenAPI', async () => {
    const doc = (await (await fetch(`${base}/docs-json`)).json()) as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths['/v1/channels/whatsapp/enlace']?.post).toBeTruthy();
    expect(doc.paths['/v1/channels/whatsapp/numeros']?.get).toBeTruthy();
    expect(doc.paths['/v1/channels/whatsapp/conectar']?.post).toBeTruthy();
  });
});
