// Orquestador de la línea base local (#79): levanta un JWKS local (hace
// de Supabase Auth), la API real compilada, siembra datos SINTÉTICOS y
// corre los cuatro escenarios k6 de infra/load (docker grafana/k6,
// network host). Vive en apps/api para resolver sus dependencias;
// se invoca con: pnpm --filter @iaxti/api exec node load-local.mjs
// Necesita Postgres y Redis (docker compose up) y `pnpm turbo build`.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound } from '@iaxti/module-conversations';
import { createAgent } from '@iaxti/module-agents';

const aqui = dirname(fileURLToPath(import.meta.url)); // apps/api
const raiz = resolve(aqui, '../..');
const escenarios = resolve(raiz, 'infra/load');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const JWKS_PORT = 4022;
const API_PORT = 4020;
const ISSUER = `http://127.0.0.1:${JWKS_PORT}/auth/v1`;
const BASE = `http://127.0.0.1:${API_PORT}`;
const WEBHOOK_SECRET = 'k6-secreto-simulador';

const hijos = [];
let terminando = false;
function limpiar(code) {
  terminando = true;
  for (const p of hijos) p.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => limpiar(130));

async function main() {
  // 1. JWKS local.
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig' };
  const jwks = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((ok) => jwks.listen(JWKS_PORT, ok));

  // 2. Seed sintético: tenant + equipo + canal simulador + agente + cartera.
  const pool = createPool(DATABASE_URL);
  await runMigrations(pool);
  const t = await pool.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('carga-k6', 'crece', 'active') RETURNING id",
  );
  const tenant = t.rows[0].id;
  const duena = randomUUID();
  const inv = await withTenant(pool, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'carga@k6.cl', roleName: 'ADMIN' }),
  );
  await withTenant(pool, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));

  const cuenta = await pool.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, state, webhook_secret_ref)
     VALUES ($1, 'simulador', 'k6', 'active', 'K6_WEBHOOK_SECRET') RETURNING id`,
    [tenant],
  );
  const agente = await withTenant(pool, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'K6', fallbackSystemPrompt: 'x', actor: 'seed' }),
  );

  console.log('seed: sembrando cartera sintética (200 contactos, ~400 conversaciones)…');
  const convIds = [];
  for (let i = 0; i < 200; i++) {
    const phone = `+5698${String(1000000 + i)}`;
    for (let j = 0; j < 2; j++) {
      const res = await withTenant(pool, tenant, (c) =>
        receiveInbound(c, { tenantId: tenant, phone, channel: 'simulador', body: `hola ${i}-${j}` }),
      );
      if (j === 0) convIds.push(res.conversation.id);
    }
  }

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(duena)
    .setIssuer(ISSUER)
    .setExpirationTime('2h')
    .sign(privateKey);

  // 3. La API real, compilada (dist), con el JWKS local (patrón del e2e).
  const api = spawn('node', ['apps/api/dist/main.js'], {
    cwd: raiz,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DATABASE_URL,
      REDIS_URL,
      SUPABASE_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
      IAXTI_ENV: 'e2e',
      RATE_LIMIT_PER_MINUTE: '100000', // el rate limit propio no es lo que medimos
      K6_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
    stdio: 'inherit',
  });
  hijos.push(api);
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch { /* aún no */ }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  console.log('api: arriba en', BASE);

  // 4. Los cuatro escenarios, uno tras otro (números limpios).
  const comunes = ['--rm', '--network', 'host', '-v', `${escenarios}:/l`, 'grafana/k6', 'run'];
  const corridas = [
    ['bandeja', ['-e', `BASE=${BASE}`, '-e', `TOKEN=${token}`, '-e', `TENANT=${tenant}`, '-e', 'VUS=20', '/l/escenarios/bandeja.js']],
    ['webhooks', ['-e', `BASE=${BASE}`, '-e', `ACCOUNT=${cuenta.rows[0].id}`, '-e', `WEBHOOK_SECRET=${WEBHOOK_SECRET}`, '-e', 'RATE=50', '/l/escenarios/webhooks.js']],
    ['salientes', ['-e', `BASE=${BASE}`, '-e', `TOKEN=${token}`, '-e', `TENANT=${tenant}`, '-e', `CONVS=${convIds.slice(0, 50).join(',')}`, '-e', 'RATE=20', '/l/escenarios/salientes.js']],
    ['ia', ['-e', `BASE=${BASE}`, '-e', `TOKEN=${token}`, '-e', `TENANT=${tenant}`, '-e', `AGENT=${agente.id}`, '-e', `CONV=${convIds[0]}`, '-e', 'VUS=10', '/l/escenarios/ia.js']],
  ];
  let fallo = 0;
  for (const [nombre, args] of corridas) {
    console.log(`\n===== k6: ${nombre} =====`);
    // spawn ASÍNCRONO: spawnSync bloquearía el event loop y el JWKS de
    // este mismo proceso dejaría de responder (timeout de jose = 5 s).
    const status = await new Promise((ok) => {
      const r = spawn('docker', ['run', ...comunes, ...args], { stdio: 'inherit' });
      r.on('exit', (code) => ok(code ?? 1));
    });
    if (status !== 0) {
      console.error(`k6: ${nombre} NO cumplió sus umbrales`);
      fallo = 1;
    }
  }

  // El webhook k6 usa firma cruda del simulador: verifícala una vez a mano.
  void createHmac;
  await pool.end();
  limpiar(fallo);
}

main().catch((e) => {
  console.error(e);
  limpiar(1);
});
