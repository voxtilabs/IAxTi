// El Supabase Auth del AMBIENTE LOCAL (#1047) — y de ningún otro.
//
// Hace lo mínimo que supabase-js y la API necesitan para que una persona
// entre al panel local sin Supabase real: publica un JWKS, firma tokens de
// los usuarios del seed, y contesta el refresh para que la sesión no muera
// a la hora. Es el mismo patrón del e2e (run-e2e.mjs levanta un JWKS
// efímero para Playwright); esto es su equivalente humano.
//
// Por qué NO puede llegar a staging/prod, en capas:
// 1. Vive en infra/, que el Dockerfile jamás copia (solo apps y packages):
//    no existe imagen que lo contenga.
// 2. El compose local lo monta como archivo en un node:alpine pelado; los
//    compose de Dokploy no lo declaran (y una guarda muerde si aparece).
// 3. Si igual alguien lo arrancara con IAXTI_ENV de staging/producción,
//    se niega a arrancar (abajo).
// 4. La página /entrar-local del web tiene su propia doble cerradura.
//
// Cero dependencias a propósito: node:crypto firma ES256 (ECDSA P-256 +
// SHA-256 con r||s de 64 bytes, que es exactamente lo que JWS pide) y el
// JWK sale de publicKey.export({format:'jwk'}).

import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

const AMBIENTE = process.env.IAXTI_ENV;
if (AMBIENTE === 'production' || AMBIENTE === 'staging') {
  console.error(`auth-local: me negué a arrancar con IAXTI_ENV=${AMBIENTE}. Esto es SOLO para desarrollo local.`);
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3004);
const ISSUER = process.env.AUTH_ISSUER ?? `http://auth-local:${PORT}/auth/v1`;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3002';
// Solo el dominio del seed de demostración: este servidor firma identidades,
// y las únicas que tiene sentido firmar son las que el seed creó.
const DOMINIO_PERMITIDO = '@demo-iaxti.cl';
const VIDA_ACCESS_SEG = 60 * 60;

// Llave NUEVA por arranque, kid con el instante: si el contenedor se
// reinicia, la API refetchea el JWKS al ver un kid desconocido y los tokens
// viejos simplemente obligan a entrar de nuevo — no hay nada que persistir.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = `local-${Date.now()}`;
// generateKeyPairSync sin encoding ya devuelve KeyObjects listos para firmar.
const JWK = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'ES256', kid: KID };

const b64u = (datos) => Buffer.from(datos).toString('base64url');

function firmarJwt(payload, vidaSegundos) {
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KID }));
  const cuerpo = b64u(JSON.stringify({ ...payload, iat: ahora, exp: ahora + vidaSegundos }));
  const firma = sign('sha256', Buffer.from(`${header}.${cuerpo}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${cuerpo}.${firma}`;
}

function leerJwt(token) {
  const [h, p, f] = String(token ?? '').split('.');
  if (!h || !p || !f) return null;
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(f, 'base64url'),
  );
  if (!ok) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// El MISMO uuid determinista del seed (packages/seed/src/seed.ts): el sub
// del token tiene que ser el user_id que el seed dejó en user_roles, o el
// guard contesta NOT_A_MEMBER con toda la razón.
function stableUuid(email) {
  const h = createHash('sha256').update(`iaxti-seed:${email}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function sesionPara(email) {
  const sub = stableUuid(email);
  const user = { id: sub, aud: 'authenticated', email, role: 'authenticated' };
  return {
    access_token: firmarJwt({ iss: ISSUER, sub, email, aud: 'authenticated' }, VIDA_ACCESS_SEG),
    token_type: 'bearer',
    expires_in: VIDA_ACCESS_SEG,
    expires_at: Math.floor(Date.now() / 1000) + VIDA_ACCESS_SEG,
    // El refresh es otro JWT propio con el email adentro: al canjearlo se
    // vuelve a firmar todo. 30 días — es una máquina de desarrollo.
    refresh_token: firmarJwt({ tipo: 'refresh', email }, 30 * 24 * 60 * 60),
    user,
  };
}

function responder(res, status, cuerpo) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': WEB_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-supabase-api-version',
  });
  res.end(cuerpo === undefined ? '' : JSON.stringify(cuerpo));
}

async function cuerpoJson(req) {
  let crudo = '';
  for await (const pedazo of req) crudo += pedazo;
  try {
    return JSON.parse(crudo || '{}');
  } catch {
    return {};
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return responder(res, 204);

  if (url.pathname.endsWith('/jwks.json')) {
    return responder(res, 200, { keys: [JWK] });
  }

  // La entrada humana: la página /entrar-local del web la llama con el email.
  if (req.method === 'POST' && url.pathname === '/entrar') {
    const { email } = await cuerpoJson(req);
    if (typeof email !== 'string' || !email.endsWith(DOMINIO_PERMITIDO)) {
      return responder(res, 400, {
        code: 'EMAIL_FUERA_DEL_SEED',
        message: `Acá solo entran los usuarios del seed (*${DOMINIO_PERMITIDO}). Corre pnpm seed y usa duena@demo-iaxti.cl o vendedor@demo-iaxti.cl.`,
      });
    }
    return responder(res, 200, sesionPara(email));
  }

  // Lo que supabase-js necesita del lado GoTrue: refresh, user y logout.
  if (req.method === 'POST' && url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const { refresh_token } = await cuerpoJson(req);
    const payload = leerJwt(refresh_token);
    if (!payload || payload.tipo !== 'refresh') {
      return responder(res, 400, { error: 'invalid_grant', error_description: 'refresh vencido: entra de nuevo por /entrar-local' });
    }
    return responder(res, 200, sesionPara(payload.email));
  }
  if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const payload = leerJwt(token);
    if (!payload?.sub) return responder(res, 401, { message: 'token inválido' });
    return responder(res, 200, { id: payload.sub, aud: 'authenticated', email: payload.email, role: 'authenticated' });
  }
  if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
    return responder(res, 204);
  }
  if (url.pathname === '/auth/v1/health' || url.pathname === '/health') {
    return responder(res, 200, { status: 'ok', service: 'auth-local', kid: KID });
  }

  return responder(res, 404, { message: 'auth-local: acá no hay nada más que jwks, entrar, refresh, user y logout' });
}).listen(PORT, () => {
  console.log(`auth-local arriba en :${PORT} · issuer ${ISSUER} · kid ${KID} · solo *${DOMINIO_PERMITIDO}`);
});
