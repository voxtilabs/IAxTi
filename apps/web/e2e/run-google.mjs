// UI de #57 con API/JWT/Postgres locales y respuestas de Google interceptadas
// en Playwright. No acredita consentimiento ni entrega push del proveedor real.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { porQueNoCorrer } from './build-coherente.mjs';
const here = dirname(fileURLToPath(import.meta.url)); const root = resolve(here, '../../..');
const dbUrl = process.env.DATABASE_URL; const appDbUrl = process.env.APP_DATABASE_URL;
if (!dbUrl || !appDbUrl || !new URL(dbUrl).pathname.startsWith('/iaxti_test_')) throw new Error('Usa una base de pruebas iaxti_test_ y APP_DATABASE_URL con RLS.');
const apiPort = 4027; const webPort = 4028; const authPort = 4029;
const issuer = `http://127.0.0.1:${authPort}/auth/v1`; const children = [];
let jwks;
const launch = (command, args, env, cwd = root) => { const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }); children.push(child); return child; };
async function ready(url) {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) return; } catch { /* servidor arrancando */ } await new Promise(r => setTimeout(r, 500)); }
  throw new Error('El servidor local no respondió.');
}
try {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const key = { ...await exportJWK(publicKey), alg: 'ES256', kid: 'google-e2e' };
  jwks = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [key] })); }).listen(authPort, '127.0.0.1');
  const db = createPool(dbUrl); let tenantId; const userId = randomUUID();
  try {
    await runMigrations(db);
    tenantId = (await db.query("INSERT INTO tenants(name) VALUES('Google Calendar E2E') RETURNING id")).rows[0].id;
    // Admin separado: la persona que prueba Calendar sigue siendo USER.
    for (const [id, roleName] of [[randomUUID(), 'ADMIN'], [userId, 'USER']]) {
      const invitation = await withTenant(db, tenantId, c => createInvitation(c, { tenantId, email: `${id}@example.test`, roleName }));
      await withTenant(db, tenantId, c => acceptInvitation(c, { token: invitation.token, userId: id }));
    }
    await db.query('GRANT USAGE ON SCHEMA public TO iaxti_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO iaxti_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_app; REVOKE UPDATE,DELETE ON audit_log FROM iaxti_app');
  } finally { await db.end(); }
  const accessToken = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: key.kid }).setSubject(userId).setIssuer(issuer).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  writeFileSync(join(here, '.auth.json'), JSON.stringify({ accessToken, userId, tenantId, webUrl: `http://127.0.0.1:${webPort}` }));
  launch('node', ['apps/api/dist/main.js'], { PORT: String(apiPort), DATABASE_URL: appDbUrl, REDIS_URL: 'redis://127.0.0.1:56379/10', SUPABASE_JWKS_URL: `${issuer}/.well-known/jwks.json`, IAXTI_ENV: 'e2e', RATE_LIMIT_PER_MINUTE: '100000' });
  await ready(`http://127.0.0.1:${apiPort}/health`);
  const web = join(root, 'apps/web'); const standalone = join(web, '.next/standalone/apps/web');
  const objection = porQueNoCorrer({ delStandalone: readFileSync(join(standalone, '.next/BUILD_ID'), 'utf8'), delNext: readFileSync(join(web, '.next/BUILD_ID'), 'utf8') });
  if (objection) throw new Error(objection);
  rmSync(join(standalone, '.next/static'), { recursive: true, force: true }); mkdirSync(join(standalone, '.next'), { recursive: true });
  cpSync(join(web, '.next/static'), join(standalone, '.next/static'), { recursive: true });
  if (existsSync(join(web, 'public'))) cpSync(join(web, 'public'), join(standalone, 'public'), { recursive: true });
  launch('node', ['server.js'], { NODE_ENV: 'production', PORT: String(webPort), HOSTNAME: '127.0.0.1', API_URL_PUBLIC: `http://127.0.0.1:${apiPort}`, API_URL_INTERNAL: `http://127.0.0.1:${apiPort}`, SUPABASE_URL: `http://127.0.0.1:${authPort}`, SUPABASE_ANON_KEY: 'test-anon' }, standalone);
  await ready(`http://127.0.0.1:${webPort}/login`);
  const pw = launch('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.google.config.ts', ...process.argv.slice(2)], {}, web);
  process.exitCode = await new Promise(resolve => pw.once('exit', code => resolve(code ?? 1)));
} catch (error) { console.error(error instanceof Error ? error.message : 'Falló el arnés local.'); process.exitCode = 1; }
finally { for (const child of children) child.kill('SIGTERM'); jwks?.close(); }
