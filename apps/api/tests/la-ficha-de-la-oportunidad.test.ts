import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createDeal, createPipeline, moveDealStage } from '@iaxti/module-crm';
import { writeAudit } from '@iaxti/module-audit';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';
import { urlDeLaApp } from './url-de-la-app';

/**
 * La ficha de una oportunidad (#1301).
 *
 * No se podía entrar a una oportunidad: la API tenía `GET deals`,
 * `POST deals/:id/stage` y `GET deals/:id/etapas`, pero ninguna que devolviera
 * UNA. El tablero mostraba tarjetas que no llevaban a ningún lado.
 *
 * Lo que esta prueba cuida, además de que la ficha exista, es la pregunta que
 * Lino hizo y que el producto no contestaba: **¿la IA está gestionando esto?**
 * El rastro del asistente se separa de lo que hizo una persona, porque son dos
 * hechos distintos para quien abre la ficha.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
let deal: string;
let etapas: Array<{ id: string; name: string; type: string }>;
const duena = randomUUID();

async function pedir(path: string): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    headers: {
      Authorization: `Bearer ${await firmar(duena)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
    },
  });
}

type Ficha = {
  deal: Record<string, unknown>;
  historia: Array<Record<string, unknown>>;
  activities: unknown[];
  delAsistente: Array<Record<string, unknown>>;
};

async function ficha(id = deal): Promise<Ficha> {
  const r = await pedir(`/deals/${id}`);
  const cuerpo = await r.text();
  expect(r.status, cuerpo).toBe(200);
  return JSON.parse(cuerpo) as Ficha;
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('ficha-deal') RETURNING id"))
    .rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'duena@ficha.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));

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
  const contacto = (
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,'Ana Soto',$2,'whatsapp') RETURNING id`,
      [tenant, `+569${String(Date.now()).slice(-8)}`],
    )
  ).rows[0].id;

  const d = await withTenant(admin, tenant, (c) =>
    createDeal(c, {
      tenantId: tenant,
      contactId: contacto,
      pipelineId: pipe.pipeline.id,
      title: 'Corte y barba',
      value: 25_000,
      currency: 'CLP',
      actor: duena,
    }),
  );
  deal = d.id;

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
  await app?.close();
  await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
  for (const t of ['deal_stage_history', 'activities', 'deals', 'stages', 'pipelines', 'contacts',
                   'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin?.end();
});

describe('la ficha de una oportunidad (#1301)', () => {
  it('se puede entrar: trae el deal con su etapa y su contacto por NOMBRE', async () => {
    const f = await ficha();
    expect(f.deal.title).toBe('Corte y barba');
    // Resueltos por nombre: una lista de uuids no le dice nada a nadie.
    expect(f.deal.stage_name, 'la etapa').toBeTruthy();
    expect(f.deal.pipeline_name, 'el embudo').toBe('Ventas');
    expect(f.deal.contact_name, 'de quién es').toBe('Ana Soto');
    expect(f.deal.contact_phone).toMatch(/^\+569/);
  });

  it('una oportunidad que no existe da 404 con su código, no un 500', async () => {
    const r = await pedir(`/deals/${randomUUID()}`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { code: string }).code).toBe('DEAL_NOT_FOUND');
  });

  it('la historia muestra cómo llegó hasta acá, con el primer paso como nacimiento', async () => {
    const f = await ficha();
    expect(f.historia.length, 'el alta ya es un paso').toBeGreaterThan(0);
    // El primer paso no tiene origen: la oportunidad no viene de ninguna
    // etapa, nace. La pantalla lo muestra como «creada» y no como un
    // movimiento desde la nada.
    expect(f.historia[0].from_stage_id).toBeNull();
    expect(f.historia[0].to_stage_name).toBeTruthy();
  });

  it('y cada movimiento posterior queda, en orden', async () => {
    const siguiente = etapas.find((e) => e.type === 'open' && e.id !== etapas[0].id) ?? etapas[1];
    await withTenant(admin, tenant, (c) =>
      moveDealStage(c, { tenantId: tenant, dealId: deal, stageId: siguiente.id, actor: duena }),
    );
    const f = await ficha();
    expect(f.historia.length).toBeGreaterThan(1);
    const ultimo = f.historia[f.historia.length - 1];
    expect(ultimo.to_stage_name).toBe(siguiente.name);
    expect(ultimo.from_stage_id, 'un movimiento SÍ tiene origen').not.toBeNull();
  });

  /**
   * La pregunta que el producto no contestaba: ¿la IA está gestionando esto?
   *
   * El rastro del asistente viene separado de lo que hizo una persona. «Lo
   * movió Ana» y «lo movió el asistente» son dos hechos distintos para quien
   * abre la ficha, y el segundo es el que nadie podía ver.
   */
  it('lo que hizo el ASISTENTE viene aparte de lo que hizo una persona', async () => {
    await withTenant(admin, tenant, (c) =>
      writeAudit(c, {
        tenantId: tenant,
        actor: 'agente',
        actorKind: 'agent',
        action: 'crm.deal.created',
        resource: 'deal',
        resourceId: deal,
        result: 'success',
      }),
    );
    const f = await ficha();
    expect(f.delAsistente.length, 'lo del agente tiene que aparecer').toBe(1);
    expect(f.delAsistente[0].action).toBe('crm.deal.created');
    expect(f.delAsistente[0].actorKind ?? f.delAsistente[0].actor_kind).toBe('agent');
  });

  it('y lo que hizo una persona NO se cuenta como del asistente', async () => {
    // Es la mitad que importa: si acá entrara lo de las personas, la ficha
    // diría que la IA gestiona el embudo cuando no lo hace.
    await withTenant(admin, tenant, (c) =>
      writeAudit(c, {
        tenantId: tenant,
        actor: duena,
        actorKind: 'user',
        action: 'crm.deal.updated',
        resource: 'deal',
        resourceId: deal,
        result: 'success',
      }),
    );
    const f = await ficha();
    expect(f.delAsistente.map((e) => e.action)).toEqual(['crm.deal.created']);
  });

  it('el rastro es de ESTA oportunidad y no de todas', async () => {
    // `resourceId` es lo que #1301 agregó al filtro de auditoría: sin él se
    // podía pedir «todo lo que pasó con oportunidades» pero no «todo lo que
    // pasó con esta».
    const suyos = await admin.query('SELECT pipeline_id FROM deals WHERE id = $1', [deal]);
    // Otro contacto, y no el mismo: el producto no deja dos oportunidades
    // abiertas del mismo contacto en un embudo —«ciérrala antes de abrir
    // otra»—, que es una regla del negocio y no un estorbo de la prueba.
    const otroContacto = (
      await admin.query(
        `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,'Beto Díaz',$2,'whatsapp') RETURNING id`,
        [tenant, `+5698${String(Date.now()).slice(-7)}`],
      )
    ).rows[0].id;
    const otro = await withTenant(admin, tenant, (c) =>
      createDeal(c, {
        tenantId: tenant,
        contactId: otroContacto,
        pipelineId: suyos.rows[0].pipeline_id,
        title: 'Otra cosa',
        actor: duena,
      }),
    );
    expect((await ficha(otro.id)).delAsistente).toEqual([]);
    expect((await ficha()).delAsistente.length).toBe(1);
  });
});
