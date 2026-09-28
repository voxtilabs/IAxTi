import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { RateLimitGuard } from '../src/rate-limit.guard';

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

/**
 * El cupo por omisión no puede frenar a alguien que solo está trabajando (#686).
 *
 * Estaba en 120 por minuto y POR TENANT. Medido en la traza de red de una sola
 * prueba de la bandeja —un usuario abre una conversación y responde—: **31
 * llamadas a /v1**. O sea, cuatro de esos flujos por minuto para el negocio
 * entero, entre todos sus usuarios.
 *
 * Y no era teórico: en CI el POST del mensaje y el cambio de estado volvieron
 * **429**, la bandeja se quedó «En curso», y cuatro PR quedaron bloqueados por un
 * rojo que no hablaba de ellos. Antes de eso, un mensaje que no se enviaba y
 * nadie supo por qué.
 *
 * Esta prueba fija el número contra la medición, no contra el gusto: si alguien lo
 * vuelve a bajar al orden de una sola sesión de trabajo, se cae y se lee por qué.
 */
describe('el cupo por omisión aguanta una jornada normal (#686)', () => {
  // Medido, no estimado: 31 llamadas a /v1 en una prueba que abre una
  // conversación y manda un mensaje.
  const LLAMADAS_POR_FLUJO = 31;
  const porOmision = () => {
    const guard = new RateLimitGuard({} as never);
    return Reflect.get(guard, 'limitPerMinute') as number;
  };

  it('deja trabajar a varias personas del mismo negocio a la vez', () => {
    const personas = 3;
    const flujosPorMinuto = 5;
    expect(
      porOmision(),
      `Con ${porOmision()} por minuto y por tenant, ${personas} personas haciendo ` +
        `${flujosPorMinuto} flujos de bandeja por minuto (${LLAMADAS_POR_FLUJO} llamadas cada uno) ` +
        'reciben "Espera un momento" por estar trabajando.',
    ).toBeGreaterThanOrEqual(personas * flujosPorMinuto * LLAMADAS_POR_FLUJO);
  });

  it('pero sigue siendo un tope: no es «sin límite»', () => {
    // Quitarlo sería cambiar un problema por otro. Lo que se corrigió es el
    // número, no la política.
    expect(porOmision()).toBeLessThan(10_000);
  });
});
