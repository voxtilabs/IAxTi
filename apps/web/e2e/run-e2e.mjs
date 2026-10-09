// Orquestador del e2e de la bandeja (#37, criterio de salida de Fase 2):
// levanta un JWKS local (hace de Supabase Auth), la API real y el web
// standalone, siembra un supervisor con una conversación simulada y corre
// Playwright en viewport de celular. Necesita Postgres y Redis (CI o
// docker compose up) y `pnpm turbo build` previo.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { porQueNoCorrer } from './build-coherente.mjs';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createContact, createDeal, createPipeline, createTag } from '@iaxti/module-crm';
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
  // TRES conversaciones, no una (#694).
  //
  // Con una sola, `bandeja.spec.ts` la RESUELVE —es su criterio de salida— y una
  // conversación resuelta sale del filtro por omisión de la lista. Cualquier otra
  // prueba que corra después se queda sin nada que abrir y falla con «waiting for
  // getByRole('button', { name: /\+56 ?9/ })», que no dice nada del cambio que la
  // recibe. Eso puso en rojo el PR #660.
  //
  // Mismo texto en las tres a propósito: las pruebas abren `.first()` y comprueban
  // ese texto, así que cualquiera de ellas sirve y el orden deja de importar.
  const conversaciones = [];
  for (let i = 0; i < 3; i++) {
    const r = await withTenant(pool, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: `+5698${`${Date.now() + i}`.slice(-7)}`,
        channel: 'simulador',
        body: 'Hola, ¿me pueden ayudar con una cotización?',
      }),
    );
    conversaciones.push(r.conversation);
  }
  const conversation = conversaciones[0];
  const keyTenant = (await pool.query("INSERT INTO tenants(name) VALUES ('E2E Teclado') RETURNING id")).rows[0].id;
  const keyInvitation = await withTenant(pool, keyTenant, (c) => createInvitation(c, { tenantId: keyTenant, email: `teclado-${supervisora.slice(0, 8)}@e2e.cl`, roleName: 'SUPERVISOR' }));
  await withTenant(pool, keyTenant, (c) => acceptInvitation(c, { token: keyInvitation.token, userId: supervisora }));
  const keyConversations = [];
  for (const [i, name] of ['Ana Teclado', 'Beto Teclado'].entries()) {
    const received = await withTenant(pool, keyTenant, (c) => receiveInbound(c, { tenantId: keyTenant, phone: `+5697300000${i}`, channel: 'simulador', body: `Cotización de ${name}` }));
    await pool.query('UPDATE contacts SET name = $2 WHERE id = $1', [received.contact.id, name]);
    keyConversations.push({ conversationId: received.conversation.id, contactId: received.contact.id, name });
  }
  const tableTenant = (await pool.query("INSERT INTO tenants(name) VALUES ('E2E Tablas') RETURNING id")).rows[0].id;
  const tableInvitation = await withTenant(pool, tableTenant, (c) => createInvitation(c, { tenantId: tableTenant, email: `tablas-${supervisora.slice(0, 8)}@e2e.cl`, roleName: 'ADMIN' }));
  await withTenant(pool, tableTenant, (c) => acceptInvitation(c, { token: tableInvitation.token, userId: supervisora }));
  const pipe = await withTenant(pool, tableTenant, (c) => createPipeline(c, { tenantId: tableTenant, name: 'Ventas de prueba', stages: [{ name: 'Nuevo', type: 'open' }, { name: 'Ganado', type: 'won' }, { name: 'Perdido', type: 'lost' }] }));
  const tableTag = await withTenant(pool, tableTenant, (c) => createTag(c, { tenantId: tableTenant, name: 'Seguimiento' }));
  for (let i = 1; i <= 30; i++) {
    const persona = await withTenant(pool, tableTenant, (c) => createContact(c, { tenantId: tableTenant, phone: `+56972${String(i).padStart(6, '0')}`, name: `Persona ${String(i).padStart(2, '0')}` }));
    await withTenant(pool, tableTenant, (c) => createDeal(c, { tenantId: tableTenant, contactId: persona.id, pipelineId: pipe.pipeline.id, title: `Venta ${String(i).padStart(2, '0')}`, value: i * 1000 }));
  }
  // Campañas (#348): negocio y datos sintéticos separados de la bandeja.
  // No se levanta workers: ningún mensaje de este ensayo sale a un proveedor.
  // Doce días de números para que el gráfico de Reportes exista (#424).
  // Sin `daily_metrics` el tablero muestra el estado vacío —que también se
  // prueba, con el tenant por defecto— y no habría gráfico que leer.
  // Valores irregulares a propósito: una escala se prueba con un pico.
  const CONVERSACIONES = [3, 7, 2, 11, 5, 0, 9, 14, 6, 4, 8, 12];
  for (const [i, conversaciones] of CONVERSACIONES.entries()) {
    const dia = `now()::date - ${CONVERSACIONES.length - 1 - i}`;
    for (const [metric, value] of [
      ['conversaciones_nuevas', conversaciones],
      ['resueltas', Math.floor(conversaciones * 0.6)],
      ['oportunidades_creadas', Math.floor(conversaciones / 3)],
    ]) {
      if (value === 0) continue;
      await pool.query(
        `INSERT INTO daily_metrics (tenant_id, day, metric, owner_id, value)
         VALUES ($1, ${dia}, $2, '00000000-0000-0000-0000-000000000000', $3)
         ON CONFLICT DO NOTHING`,
        [tableTenant, metric, value],
      );
    }
  }

  const campaignTenantId = (await pool.query("INSERT INTO tenants (name, plan) VALUES ('E2E Campañas', 'crece') RETURNING id")).rows[0].id;
  const adminInv = await withTenant(pool, campaignTenantId, (c) => createInvitation(c, {
    tenantId: campaignTenantId, email: `admin-${supervisora.slice(0, 8)}@e2e.cl`, roleName: 'ADMIN',
  }));
  await withTenant(pool, campaignTenantId, (c) => acceptInvitation(c, { token: adminInv.token, userId: supervisora }));
  const cuenta = (await pool.query("INSERT INTO channel_accounts (tenant_id, kind, name, state) VALUES ($1, 'whatsapp', 'Número sintético', 'active') RETURNING id", [campaignTenantId])).rows[0].id;
  await pool.query("INSERT INTO whatsapp_numbers (tenant_id, channel_account_id, phone_number_id, display_phone, quality) VALUES ($1, $2, $3, '+56980001111', 'green')", [campaignTenantId, cuenta, `e2e-${randomUUID()}`]);
  await pool.query("INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status) VALUES ($1, 'novedades_aprobada', 'es_CL', 'marketing', 'Hola {{1}}, tenemos novedades.', 'approved'), ($1, 'aun_sin_aprobar', 'es_CL', 'marketing', 'Borrador', 'draft')", [campaignTenantId]);
  const personas = (await pool.query("INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Ana de prueba', '+56980002222', 'whatsapp'), ($1, 'Bruno de prueba', '+56980003333', 'whatsapp'), ($1, 'Sin consentimiento', '+56980004444', 'manual') RETURNING id, name", [campaignTenantId])).rows;
  await pool.query("INSERT INTO conversations (tenant_id, contact_id, channel, last_inbound_at) VALUES ($1, $2, 'whatsapp', now())", [campaignTenantId, personas.find((p) => p.name === 'Ana de prueba').id]);
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
      tableTenantId: tableTenant,
      tableTagId: tableTag.id,
      campaignTenantId,
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
    // El limitador propio no es lo que mide esta suite (#686).
    //
    // Es el mismo criterio que `apps/api/load-local.mjs`, y acá se pagó caro por
    // no tenerlo: el cupo es por TENANT, la suite entera trabaja con uno, y una
    // sola prueba —abrir una conversación y responder— hace 31 llamadas a /v1.
    // Con 72 pruebas y dos workers en dos minutos, el cupo de 120 por minuto se
    // agota y la API empieza a contestar 429 a cualquiera.
    //
    // Eso se veía como pruebas que fallaban en CI y pasaban localmente, en un
    // punto distinto cada corrida: bandeja.spec.ts caía en «Resuelta» porque el
    // POST del mensaje volvió 429, y bandeja-scroll caía porque la página quedaba
    // corta. Lo confirmó la traza de #682: 429 en el envío Y en el cambio de
    // estado. Cuatro PR bloqueados por un rojo que no hablaba de ellos.
    RATE_LIMIT_PER_MINUTE: '100000',
  }, raiz);
  await esperar(`http://127.0.0.1:${API_PORT}/health`);

  // 5 · Web standalone (mismos pasos que el Dockerfile).
  const webDir = join(raiz, 'apps/web');
  const standalone = join(webDir, '.next/standalone/apps/web');
  if (!existsSync(join(standalone, 'server.js'))) {
    throw new Error('e2e: falta el build de web (pnpm turbo build)');
  }
  const staticDst = join(standalone, '.next/static');
  // SIEMPRE, no solo la primera vez (#635).
  //
  // Esto decía `if (!existsSync(staticDst))`, y el efecto era brutal: el build
  // regenera `server/chunks`, pero los estáticos quedaban los de la PRIMERA
  // corrida. Entonces el servidor pedía `chunks/9863-<hash nuevo>.js` y el disco
  // solo tenía el hash viejo → 404 → `ChunkLoadError` → «Application error: a
  // client-side exception has occurred» y TODA la suite en rojo.
  //
  // O sea: cualquiera que tocara el front y volviera a correr el e2e veía 70
  // pruebas rojas que parecían culpa de su cambio, y no lo eran. La primera
  // corrida de un checkout limpio pasaba; la segunda, nunca. Costó media hora
  // de esta sesión creyendo que un cambio en la barra lateral había roto la
  // aplicación entera.
  //
  // Y antes de copiar: que el standalone y el `.next` sean DEL MISMO BUILD
  // (#637). Copiar siempre arregló la mitad que se podía arreglar copiando; la
  // otra mitad es que `server.js` y sus `server/chunks` salen de
  // `.next/standalone`, y si ESO quedó de un build anterior —un build a medias,
  // un `turbo build --filter` que no tocó web, un checkout encima— la copia deja
  // un servidor viejo pidiéndole estáticos nuevos. El síntoma es idéntico:
  // `ChunkLoadError` y la suite entera roja por algo que no es el cambio.
  //
  // `BUILD_ID` es la huella que Next deja en los dos lados, así que compararla
  // es gratis. Y la respuesta correcta es NEGARSE, no apañar: una suite que
  // corre sobre un build mezclado no está verificando nada, y eso es peor que
  // no correrla — el rojo (o el verde) no habla del código que se quería
  // probar.
  {
    const buildIdDe = (dir) => {
      const archivo = join(dir, 'BUILD_ID');
      return existsSync(archivo) ? readFileSync(archivo, 'utf8').trim() : null;
    };
    const objecion = porQueNoCorrer({
      delStandalone: buildIdDe(join(standalone, '.next')),
      delNext: buildIdDe(join(webDir, '.next')),
    });
    if (objecion) throw new Error(objecion);
    // El destino se vacía antes de copiar: `force: true` sobrescribe lo que
    // calza y DEJA lo que ya no existe. Un chunk que el build nuevo no generó
    // se queda ahí, servible, y entonces el e2e puede estar corriendo contra
    // código que ya se borró. Vaciarlo vuelve la copia exacta en vez de
    // acumulada.
    rmSync(staticDst, { recursive: true, force: true });
    mkdirSync(dirname(staticDst), { recursive: true });
    cpSync(join(webDir, '.next/static'), staticDst, { recursive: true, force: true });
    // Igual que el Dockerfile (infra/docker/Dockerfile:15), para que el e2e
    // corra sobre lo mismo que producción.
    const publicSrc = join(webDir, 'public');
    if (existsSync(publicSrc)) {
      cpSync(publicSrc, join(standalone, 'public'), { recursive: true, force: true });
    }
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
  // Los argumentos extra pasan a Playwright: `node e2e/run-e2e.mjs barra-lateral`
  // corre un solo spec en vez de la suite entera. Sin esto, revisar UNA pantalla
  // obliga a levantar todo y esperar dos minutos.
  const pw = lanzar('playwright', 'npx', ['playwright', 'test', ...process.argv.slice(2)], {}, webDir);
  pw.on('exit', (code) => {
    jwks.close();
    // En local la base persiste entre corridas: los eventos del e2e quedan
    // "procesados" para no contaminar los tests del despachador de outbox.
    const cierre = createPool(DATABASE_URL);
    cierre
      .query('UPDATE outbox SET processed_at = now() WHERE tenant_id = ANY($1::uuid[]) AND processed_at IS NULL', [[tenant, keyTenant, tableTenant, campaignTenantId]])
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
