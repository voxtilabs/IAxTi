import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createPool } from '@iaxti/db';
import { createApp } from '../src/main';
import { checkReadiness } from '../src/readiness';

// `/health` y `/ready` no son lo mismo (#17). Confundirlos hace que un
// orquestador mande tráfico a una instancia que no puede contestar, o que
// reinicie una que solo estaba esperando a la base.

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

describe('salud y disponibilidad', () => {
  it('/health no mira dependencias: si fallara, reiniciarían el proceso', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({ status: 'ok', service: 'api' });
    // Si /health empezara a mirar la base, una base lenta provocaría
    // reinicios en cadena justo cuando menos conviene.
    expect(cuerpo.dependencias).toBeUndefined();
  });

  it('/ready sí las mira y las reporta una por una', async () => {
    const res = await fetch(`${base}/ready`);
    const cuerpo = await res.json();
    expect(cuerpo.dependencias.map((d: { nombre: string }) => d.nombre)).toEqual([
      'postgres',
      'redis',
    ]);
    for (const dep of cuerpo.dependencias) {
      expect(typeof dep.ms).toBe('number');
    }
    // Con base configurada en el test, listo; el status HTTP acompaña.
    expect(res.status).toBe(cuerpo.status === 'ok' ? 200 : 503);
  });

  it('sin base no está listo, y lo dice con 503', async () => {
    const estado = await checkReadiness(null, 'api');
    expect(estado.status).toBe('degraded');
    const pg = estado.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(false);
    expect(pg.detalle).toMatch(/DATABASE_URL/);
  });

  it('una base que no responde deja la instancia fuera de rotación, no muerta', async () => {
    // Puerto cerrado: el intento falla rápido y el chequeo corta por tope.
    const muerta = createPool('postgres://nadie:nadie@127.0.0.1:59999/vacio');
    try {
      const estado = await checkReadiness(muerta, 'api');
      expect(estado.status).toBe('degraded');
      expect(estado.dependencias.find((d) => d.nombre === 'postgres')!.ok).toBe(false);
    } finally {
      await muerta.end().catch(() => {});
    }
  });
});
