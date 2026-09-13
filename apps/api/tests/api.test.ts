import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import {
  CursorInvalidoError,
  decodeCursor,
  encodeCursor,
  parsePageParams,
  toPage,
} from '../src/lib/pagination';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await createApp();
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe('API base', () => {
  it('X-Request-Id entra o se genera, y vuelve en la respuesta', async () => {
    const generado = await fetch(`${base}/health`);
    expect(generado.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{24}$/);

    const propio = await fetch(`${base}/health`, { headers: { 'X-Request-Id': 'req_mio_123' } });
    expect(propio.headers.get('x-request-id')).toBe('req_mio_123');
  });

  it('los errores usan el formato único con requestId y voz Pulso', async () => {
    const res = await fetch(`${base}/v1/demo/no-existe/abc`, {
      headers: { 'X-Request-Id': 'req_error_1' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      code: 'CONTACT_NOT_FOUND',
      message: 'No encontramos ese contacto. Puede que se haya eliminado.',
      requestId: 'req_error_1',
      details: [{ id: 'abc' }],
    });
  });

  it('una ruta inexistente responde NOT_FOUND en el formato único, sin stack', async () => {
    const res = await fetch(`${base}/v1/nada`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.requestId).toMatch(/^req_/);
    expect(body.message).not.toMatch(/Cannot GET/);
  });

  it('GET /me/modules arma navegación desde los manifiestos activos', async () => {
    const res = await fetch(`${base}/v1/me/modules`);
    expect(res.status).toBe(200);
    const mods = await res.json();
    const ids = mods.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['identity', 'organizations', 'authorization', 'audit']));
    for (const m of mods) {
      expect(m).toHaveProperty('nav');
      expect(m).toHaveProperty('widgets');
    }
  });

  it('la salud queda fuera del prefijo /v1 y OpenAPI se publica en /docs', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health/modules`)).status).toBe(200);
    const docs = await fetch(`${base}/docs-json`);
    expect(docs.status).toBe(200);
    const spec = await docs.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toContain('/v1/me/modules');
  });
});

describe('paginación por cursor', () => {
  it('codifica y decodifica cursores opacos', () => {
    const cursor = encodeCursor({ created_at: '2026-09-13', id: 7 });
    expect(decodeCursor(cursor)).toEqual({ created_at: '2026-09-13', id: 7 });
    expect(() => decodeCursor('no-es-base64-json')).toThrow(CursorInvalidoError);
  });

  it('acota el límite a 100 y usa 25 por defecto', () => {
    expect(parsePageParams({}).limit).toBe(25);
    expect(parsePageParams({ limit: '999' }).limit).toBe(100);
    expect(parsePageParams({ limit: '-3' }).limit).toBe(1);
    expect(parsePageParams({ limit: 'nan' }).limit).toBe(25);
  });

  it('toPage detecta si hay más filas con la fila extra', () => {
    const filas = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const con = toPage(filas, 2, (r) => ({ id: r.id }));
    expect(con.items).toHaveLength(2);
    expect(decodeCursor(con.nextCursor as string)).toEqual({ id: 2 });

    const sin = toPage(filas, 3, (r) => ({ id: r.id }));
    expect(sin.items).toHaveLength(3);
    expect(sin.nextCursor).toBeNull();
  });
});
