import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';

// Cabeceras de respuesta (#81). Salieron del primer escaneo ZAP real contra
// staging; este test es para que no vuelvan a perderse en silencio.

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

describe('cabeceras de seguridad', () => {
  it('no anuncia el framework y prohíbe cachear la respuesta', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
    // Un JSON de un tenant en un caché compartido es una fuga esperando.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('HSTS no sale en desarrollo: sobre http dejaría al navegador sin poder entrar', async () => {
    const antes = process.env.IAXTI_ENV;
    delete process.env.IAXTI_ENV;
    try {
      const plano = await fetch(`${base}/health`);
      expect(plano.headers.get('strict-transport-security')).toBeNull();

      // Un proxy que declara el protocolo real igual lo enciende.
      const trasProxy = await fetch(`${base}/health`, {
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(trasProxy.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
    } finally {
      if (antes === undefined) delete process.env.IAXTI_ENV;
      else process.env.IAXTI_ENV = antes;
    }
  });

  it('en un ambiente desplegado sale SIEMPRE, aunque el último salto sea http', async () => {
    // Detrás de Cloudflare Tunnel + Traefik, `x-forwarded-proto` llega como
    // http: el tramo final hacia la app no es TLS. Confiar solo en el proto
    // dejaba staging sin HSTS para siempre — lo cazó el escaneo real.
    const antes = process.env.IAXTI_ENV;
    process.env.IAXTI_ENV = 'staging';
    try {
      const res = await fetch(`${base}/health`, { headers: { 'x-forwarded-proto': 'http' } });
      expect(res.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
    } finally {
      if (antes === undefined) delete process.env.IAXTI_ENV;
      else process.env.IAXTI_ENV = antes;
    }
  });

  it('el widget de webchat es cross-origin a propósito; el resto de la API no', async () => {
    const api = await fetch(`${base}/health`);
    expect(api.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    // El widget vive incrustado en el sitio del cliente: ahí la política
    // tiene que permitirlo o el snippet deja de funcionar.
    const widget = await fetch(`${base}/webchat/cualquiera`);
    expect(widget.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });
});
