import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async headers() {
    return [{ source: '/integraciones/drive/callback', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' },{key:'Cache-Control',value:'no-store'}] },{ source:'/ajustes/drive',headers:[{key:'Referrer-Policy',value:'no-referrer'},{key:'Content-Security-Policy',value:"script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com; frame-src https://accounts.google.com https://docs.google.com; object-src 'none'; base-uri 'self'"}] },{ source: '/agenda/google/callback', headers: [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Cache-Control', value: 'no-store' },
    ] }];
  },
  /**
   * Dónde empieza a trazar los archivos del standalone.
   *
   * Sin esto Next lo ADIVINA subiendo hasta encontrar un lockfile, y si
   * arriba del repo hay otro proyecto —un checkout dentro de `~/.cache`, por
   * ejemplo— lo toma como raíz: el build "termina bien" y
   * `.next/standalone/apps/web/server.js` no existe. El Dockerfile y el e2e
   * esperan exactamente esa ruta, así que se fija en la raíz del monorepo y
   * deja de depender de dónde esté clonado.
   */
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../..'),
  serverExternalPackages: [
    '@iaxti/telemetry',
    '@sentry/node',
    '@opentelemetry/sdk-node',
    '@opentelemetry/auto-instrumentations-node',
  ],
};

export default nextConfig;
