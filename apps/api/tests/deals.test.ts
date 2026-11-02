import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import {
  createContact,
  createDeal,
  createPipeline,
  ensureDefaultLossReasons,
} from '@iaxti/module-crm';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// El tablero por API (#33): visibilidad §10/§23, movimiento con motivos y
// filtros guardados por usuario.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const supervisora = randomUUID();
const vendedor = randomUUID();
/** Con ADMIN: `crm.pipelines.manage` es un permiso de configuración (#1172). */
const administradora = randomUUID();
let dealAjeno: string; // de la supervisora
let dealLibre: string; // sin dueño
let etapas: Array<{ id: string; name: string; type: string }>;

async function pedir(quien: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-deals') RETURNING id");
  tenant = t.rows[0].id;
  // El negocio real ya tiene su administrador antes de invitar al equipo (#902).
  await admin.query(`INSERT INTO user_roles(tenant_id,user_id,role_id)
    SELECT $1,$2,id FROM roles WHERE base AND name='ADMIN'`, [tenant, randomUUID()]);
  for (const [userId, email, roleName] of [
    [supervisora, 'sup@deals.cl', 'SUPERVISOR'],
    [vendedor, 'vende@deals.cl', 'USER'],
    [administradora, 'admin@deals.cl', 'ADMIN'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

  const pipe = await withTenant(admin, tenant, (c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Cotizado', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  etapas = pipe.stages;
  await withTenant(admin, tenant, (c) => ensureDefaultLossReasons(c, tenant));

  const c1 = await withTenant(admin, tenant, (c) =>
    createContact(c, { tenantId: tenant, phone: '+56972000001' }),
  );
  const c2 = await withTenant(admin, tenant, (c) =>
    createContact(c, { tenantId: tenant, phone: '+56972000002' }),
  );
  dealAjeno = (
    await withTenant(admin, tenant, (c) =>
      createDeal(c, {
        tenantId: tenant,
        contactId: c1.id,
        pipelineId: pipe.pipeline.id,
        title: 'De la supervisora',
        ownerId: supervisora,
      }),
    )
  ).id;
  dealLibre = (
    await withTenant(admin, tenant, (c) =>
      createDeal(c, {
        tenantId: tenant,
        contactId: c2.id,
        pipelineId: pipe.pipeline.id,
        title: 'Libre',
      }),
    )
  ).id;

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
  });
  await app.listen(0);
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['saved_filters', 'deal_stage_history', 'deals', 'stages', 'pipelines', 'loss_reasons', 'contacts', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('GET /v1/deals', () => {
  it('el USER ve las suyas y las libres; la SUPERVISORA (crm.read_all) ve todo', async () => {
    const deVendedor = await (await pedir(vendedor, '/deals')).json();
    expect(deVendedor.items.map((d: { title: string }) => d.title)).toEqual(['Libre']);

    const deSupervisora = await (await pedir(supervisora, '/deals')).json();
    expect(deSupervisora.items).toHaveLength(2);
  });

  it('pipelines y motivos de pérdida se listan para armar el tablero', async () => {
    const pipes = await (await pedir(vendedor, '/pipelines')).json();
    expect(pipes[0].stages).toHaveLength(4);
    const motivos = await (await pedir(vendedor, '/loss-reasons')).json();
    expect(motivos.map((m: { label: string }) => m.label)).toContain('Precio');
  });
});

describe('POST /v1/pipelines (#1172)', () => {
  it('crea el embudo con sus etapas y lo deja en la auditoría', async () => {
    /**
     * Esto es lo que el agente no podía hacer. La API sabía renombrar un
     * embudo, agregarle etapas y reordenarlas, pero no crearlo — y como el
     * catálogo de herramientas se genera del OpenAPI, lo que no es endpoint no
     * es herramienta. Mientras tanto el estado vacío de /oportunidades OFRECE
     * «Arma el embudo de mis ventas con las etapas que uso».
     */
    const res = await pedir(administradora, '/pipelines', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Arriendos',
        stages: [
          { name: 'Visita agendada', type: 'open' },
          { name: 'Propuesta enviada', type: 'open', expectedDays: 3 },
          { name: 'Arrendado', type: 'won' },
          { name: 'No arrendó', type: 'lost' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const creado = await res.json();
    expect(creado.pipeline.name).toBe('Arriendos');
    expect(creado.stages.map((e: { name: string }) => e.name)).toEqual([
      'Visita agendada',
      'Propuesta enviada',
      'Arrendado',
      'No arrendó',
    ]);
    // Y queda en la auditoría, en la misma transacción: una mutación de
    // configuración sin rastro no se puede revisar después.
    const audit = await admin.query(
      "SELECT actor, metadata FROM audit_log WHERE tenant_id = $1 AND action = 'crm.pipeline.created'",
      [tenant],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor).toBe(administradora);
    expect(audit.rows[0].metadata.etapas).toContain('Arrendado');
  });

  it('sin etapa de cierre lo rechaza diciendo QUÉ falta, no «datos inválidos»', async () => {
    // El agente se corrige con esto en el mismo turno. Un «VALIDATION_ERROR»
    // pelado lo dejaría adivinando.
    const res = await pedir(administradora, '/pipelines', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Incompleto',
        stages: [
          { name: 'Uno', type: 'open' },
          { name: 'Dos', type: 'open' },
          { name: 'Ganado', type: 'won' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const error = await res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toMatch(/perdido/i);
  });

  it('un vendedor no crea embudos: es configuración del negocio', async () => {
    const res = await pedir(vendedor, '/pipelines', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Mío',
        stages: [
          { name: 'Uno', type: 'open' },
          { name: 'Ganado', type: 'won' },
          { name: 'Perdido', type: 'lost' },
        ],
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/deals/:id/stage', () => {
  it('avanza directo; retroceder sin motivo responde 400 con voz Pulso', async () => {
    const cotizado = etapas.find((e) => e.name === 'Cotizado')!;
    const nuevo = etapas.find((e) => e.name === 'Nuevo')!;
    const ok = await pedir(supervisora, `/deals/${dealAjeno}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stageId: cotizado.id }),
    });
    expect(ok.status).toBe(201);

    const sinMotivo = await pedir(supervisora, `/deals/${dealAjeno}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stageId: nuevo.id }),
    });
    expect(sinMotivo.status).toBe(400);
    expect((await sinMotivo.json()).code).toBe('INVALID_MOVE');
  });

  it('perder exige el motivo de la lista', async () => {
    const perdido = etapas.find((e) => e.type === 'lost')!;
    const sinLista = await pedir(supervisora, `/deals/${dealLibre}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stageId: perdido.id }),
    });
    expect(sinLista.status).toBe(400);

    const motivos = await (await pedir(supervisora, '/loss-reasons')).json();
    const conLista = await pedir(supervisora, `/deals/${dealLibre}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stageId: perdido.id, lostReasonId: motivos[0].id }),
    });
    expect(conLista.status).toBe(201);
    expect((await conLista.json()).status).toBe('lost');
  });
});

describe('filtros guardados', () => {
  it('se guardan por usuario y se borran solo los propios', async () => {
    const guardado = await pedir(vendedor, '/saved-filters', {
      method: 'POST',
      body: JSON.stringify({ name: 'Mis caras', filters: { valueClpMin: '500000' } }),
    });
    expect(guardado.status).toBe(201);
    const { id } = await guardado.json();

    const deSupervisora = await (await pedir(supervisora, '/saved-filters')).json();
    expect(deSupervisora).toEqual([]); // los filtros son personales

    expect((await pedir(supervisora, `/saved-filters/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await pedir(vendedor, `/saved-filters/${id}`, { method: 'DELETE' })).status).toBe(200);
  });
});
