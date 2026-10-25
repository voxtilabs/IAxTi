import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';

/**
 * El firmador local de sesiones (#1047), probado corriéndolo de verdad:
 * se levanta el server.mjs real en un puerto efímero y se habla con él por
 * HTTP, que es lo único que el navegador y la API van a hacer. La firma se
 * verifica con node:crypto contra el JWK que ÉL publica — sin librerías de
 * por medio, el mismo contrato que la API valida con jose.
 */

const RAIZ = join(__dirname, '..', '..', '..');
const SERVER = join(RAIZ, 'infra', 'auth-local', 'server.mjs');
const PORT = 34761;
const BASE = `http://127.0.0.1:${PORT}`;

let proceso;

function stableUuid(email) {
  const h = createHash('sha256').update(`iaxti-seed:${email}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function parteDelJwt(token, indice) {
  return JSON.parse(Buffer.from(token.split('.')[indice], 'base64url').toString());
}

beforeAll(async () => {
  proceso = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), IAXTI_ENV: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* aún no */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('auth-local nunca levantó');
});

afterAll(() => {
  proceso?.kill('SIGTERM');
});

describe('el firmador local (#1047)', () => {
  it('publica un JWKS ES256 con kid, por la misma ruta que Supabase', async () => {
    const res = await fetch(`${BASE}/auth/v1/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const { keys } = await res.json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(keys[0].kid).toMatch(/^local-/);
  });

  it('firma la sesión de un usuario del seed, verificable con su propio JWKS', async () => {
    const res = await fetch(`${BASE}/entrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'duena@demo-iaxti.cl' }),
    });
    expect(res.status).toBe(200);
    const sesion = await res.json();

    // El sub ES el uuid determinista del seed: sin eso, NOT_A_MEMBER.
    const payload = parteDelJwt(sesion.access_token, 1);
    expect(payload.sub).toBe(stableUuid('duena@demo-iaxti.cl'));
    expect(payload.email).toBe('duena@demo-iaxti.cl');
    expect(payload.iss).toContain('/auth/v1');

    // La firma de verdad, contra el JWK publicado.
    const { keys } = await (await fetch(`${BASE}/auth/v1/.well-known/jwks.json`)).json();
    const publica = createPublicKey({ key: keys[0], format: 'jwk' });
    const [h, p, f] = sesion.access_token.split('.');
    const valida = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publica, dsaEncoding: 'ieee-p1363' },
      Buffer.from(f, 'base64url'),
    );
    expect(valida).toBe(true);
  });

  it('un email fuera del seed no se firma: esto no fabrica identidades', async () => {
    const res = await fetch(`${BASE}/entrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alguien@gmail.com' }),
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe('EMAIL_FUERA_DEL_SEED');
  });

  it('el refresh de supabase-js funciona: canjea y la sesión no muere a la hora', async () => {
    const sesion = await (
      await fetch(`${BASE}/entrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'vendedor@demo-iaxti.cl' }),
      })
    ).json();
    const res = await fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: sesion.refresh_token }),
    });
    expect(res.status).toBe(200);
    const nueva = await res.json();
    expect(parteDelJwt(nueva.access_token, 1).sub).toBe(stableUuid('vendedor@demo-iaxti.cl'));
    // Y un refresh inventado no canjea nada.
    const falso = await fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'x.y.z' }),
    });
    expect(falso.status).toBe(400);
  });

  it('se niega a arrancar si el ambiente dice staging o producción', async () => {
    for (const ambiente of ['staging', 'production']) {
      const salida = await new Promise((resolver) => {
        const p = spawn('node', [SERVER], {
          env: { ...process.env, PORT: '34799', IAXTI_ENV: ambiente },
          stdio: 'ignore',
        });
        p.on('exit', (code) => resolver(code));
      });
      expect(salida, `arrancó con IAXTI_ENV=${ambiente}`).toBe(1);
    }
  });
});
