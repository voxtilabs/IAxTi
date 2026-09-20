// Orquestador del e2e de la bandeja (#37, criterio de salida de Fase 2):
// levanta un JWKS local (hace de Supabase Auth), la API real y el web
// standalone, siembra un supervisor con una conversación simulada y corre
// Playwright en viewport de celular. Necesita Postgres y Redis (CI o
// docker compose up) y `pnpm turbo build` previo.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound } from '@iaxti/module-conversations';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, '../../..');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const JWKS_PORT = 4012;
const API_PORT = 4010;
const WEB_PORT = 4011;
const ISSUER = `http://127.0.0.1:${JWKS_PORT}/auth/v1`;

const hijos = [];
function lanzar(nombre, cmd, args, env, cwd) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: 'inherit' });
  p.on('exit', (code) => {
    if (code && code !== 0 && !terminando) {
      console.error(`e2e: ${nombre} murió con ${code}`);
    }
  });
  hijos.push(p);
  return p;
}

let terminando = false;
function limpiar(code) {
  terminando = true;
  for (const p of hijos) p.kill('SIGTERM');
  process.exit(code);
}

async function esperar(url, intentos = 60) {
  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`e2e: ${url} nunca respondió`);
}

async function main() {
  // 1 · Llaves y "Supabase Auth" local: un JWKS estático por HTTP.
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: 'e2e' };
  const jwks = createServer((req, res) => {
    if (req.url?.endsWith('/jwks.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  }).listen(JWKS_PORT);

  // 2 · Base: migraciones + supervisor + conversación simulada.
  const pool = createPool(DATABASE_URL);
  await runMigrations(pool);
  const supervisora = randomUUID();
  const t = await pool.query(
    "INSERT INTO tenants (name) VALUES ('E2E Bandeja') ON CONFLICT DO NOTHING RETURNING id",
  );
  const tenant =
    t.rows[0]?.id ?? (await pool.query("SELECT id FROM tenants WHERE name = 'E2E Bandeja'")).rows[0].id;
  const inv = await withTenant(pool, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: `sup-${supervisora.slice(0, 8)}@e2e.cl`, roleName: 'SUPERVISOR' }),
  );
  await withTenant(pool, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: supervisora }));
  const { conversation } = await withTenant(pool, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: `+5698${`${Date.now()}`.slice(-7)}`,
      channel: 'simulador',
      body: 'Hola, ¿me pueden ayudar con una cotización?',
    }),
  );
  const keyTenant = (await pool.query("INSERT INTO tenants(name) VALUES ('E2E Teclado') RETURNING id")).rows[0].id;
  const keyInvitation = await withTenant(pool, keyTenant, (c) => createInvitation(c, { tenantId: keyTenant, email: `teclado-${supervisora.slice(0, 8)}@e2e.cl`, roleName: 'SUPERVISOR' }));
  await withTenant(pool, keyTenant, (c) => acceptInvitation(c, { token: keyInvitation.token, userId: supervisora }));
  const keyConversations = [];
  for (const [i, name] of ['Ana Teclado', 'Beto Teclado'].entries()) {
    const received = await withTenant(pool, keyTenant, (c) => receiveInbound(c, { tenantId: keyTenant, phone: `+5697300000${i}`, channel: 'simulador', body: `Cotización de ${name}` }));
    await pool.query('UPDATE contacts SET name = $2 WHERE id = $1', [received.contact.id, name]);
    keyConversations.push({ conversationId: received.conversation.id, contactId: received.contact.id, name });
  }
  await pool.end();

  // 3 · Token de sesión firmado con nuestra llave (mismo camino que Supabase).
  const accessToken = await new SignJWT({ email: 'supervisora@e2e.cl', aud: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'e2e' })
    .setSubject(supervisora)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  writeFileSync(
    join(aqui, '.auth.json'),
    JSON.stringify({
      accessToken,
      userId: supervisora,
      tenantId: tenant,
      keyTenantId: keyTenant,
      keyConversations,
      conversationId: conversation.id,
      webUrl: `http://127.0.0.1:${WEB_PORT}`,
    }),
  );

  // 4 · API real contra el JWKS local.
  lanzar('api', 'node', ['apps/api/dist/main.js'], {
    PORT: `${API_PORT}`,
    DATABASE_URL,
    REDIS_URL,
    SUPABASE_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
    IAXTI_ENV: 'e2e',
  }, raiz);
  await esperar(`http://127.0.0.1:${API_PORT}/health`);

  // 5 · Web standalone (mismos pasos que el Dockerfile).
  const webDir = join(raiz, 'apps/web');
  const standalone = join(webDir, '.next/standalone/apps/web');
  if (!existsSync(join(standalone, 'server.js'))) {
    throw new Error('e2e: falta el build de web (pnpm turbo build)');
  }
  const staticDst = join(standalone, '.next/static');
  if (!existsSync(staticDst)) {
    mkdirSync(dirname(staticDst), { recursive: true });
    cpSync(join(webDir, '.next/static'), staticDst, { recursive: true });
  }
  lanzar('web', 'node', ['server.js'], {
    NODE_ENV: 'production',
    PORT: `${WEB_PORT}`,
    HOSTNAME: '127.0.0.1',
    API_URL_PUBLIC: `http://127.0.0.1:${API_PORT}`,
    API_URL_INTERNAL: `http://127.0.0.1:${API_PORT}`,
    SUPABASE_URL: `http://127.0.0.1:${JWKS_PORT}`,
    SUPABASE_ANON_KEY: 'e2e-anon',
  }, standalone);
  await esperar(`http://127.0.0.1:${WEB_PORT}/login`);

  // 6 · Playwright.
  const pw = lanzar('playwright', 'npx', ['playwright', 'test'], {}, webDir);
  pw.on('exit', (code) => {
    jwks.close();
    // En local la base persiste entre corridas: los eventos del e2e quedan
    // "procesados" para no contaminar los tests del despachador de outbox.
    const cierre = createPool(DATABASE_URL);
    cierre
      .query('UPDATE outbox SET processed_at = now() WHERE tenant_id = ANY($1::uuid[]) AND processed_at IS NULL', [[tenant, keyTenant]])
      .catch(() => {})
      .finally(() => {
        void cierre.end().finally(() => limpiar(code ?? 1));
      });
  });
}

process.on('SIGINT', () => limpiar(130));
main().catch((err) => {
  console.error(err);
  limpiar(1);
});
