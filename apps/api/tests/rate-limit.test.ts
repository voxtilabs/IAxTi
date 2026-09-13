import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';

// Redis local del compose. El límite bajo hace el test rápido y determinista.
const LIMITE = 3;

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await createApp({ rateLimitPerMinute: LIMITE });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe('rate limiting', () => {
  it('cuenta por tenant, expone RateLimit-* y corta con 429 en formato único', async () => {
    const tenant = `t-${Date.now()}`;
    const headers = { 'X-Tenant-Id': tenant };

    for (let i = 1; i <= LIMITE; i++) {
      const res = await fetch(`${base}/v1/me/modules`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get('ratelimit-limit')).toBe(String(LIMITE));
      expect(Number(res.headers.get('ratelimit-remaining'))).toBe(LIMITE - i);
    }

    const bloqueada = await fetch(`${base}/v1/me/modules`, { headers });
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.headers.get('retry-after')).toBeTruthy();
    const body = await bloqueada.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.message).toMatch(/Espera un momento/);
    expect(body.requestId).toMatch(/^req_/);
  });

  it('cada API key tiene su propio contador (claves separadas)', async () => {
    const conKey = await fetch(`${base}/v1/me/modules`, {
      headers: { 'X-Api-Key': `key-${Date.now()}` },
    });
    expect(conKey.status).toBe(200);
    expect(Number(conKey.headers.get('ratelimit-remaining'))).toBe(LIMITE - 1);
  });

  it('la salud no consume cuota', async () => {
    for (let i = 0; i < LIMITE + 2; i++) {
      expect((await fetch(`${base}/health`)).status).toBe(200);
    }
  });
});
