import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createTenant } from '@iaxti/module-organizations';
import { createLocalSecretStore } from '@iaxti/google';
import { partnerPorts } from '../application/partner-provider';
import { startPartnerInvitation, partnerStatus } from '../application/partner-invitations';

/**
 * El enlace del alta, con la custodia que de VERDAD se usa (#1253).
 *
 * Lo que pasaba, medido contra Zavu con un negocio creado desde cero: la
 * invitación se pedía bien, el enlace se guardaba bien —`link_ready` en ok— y
 * leerlo de vuelta fallaba —`link_accessed` en error—. El negocio recibía un
 * 503 que le decía «revisa la conexión», que es falso, y no podía conectar su
 * número nunca.
 *
 * La causa: `isLinkRef` solo aceptaba `projects/<p>/secrets/<n>/versions/<v>`,
 * la forma de Google Secret Manager. ADR-0028 dice que en v1 la custodia es el
 * disco cifrado del VPS, que produce `custodia-local/secrets/<n>/versions/<v>`.
 *
 * Y por qué `partner.test.ts` no lo cazó: monta un Secret Manager falso, o
 * sea prueba el backend que producción NO usa. Esta corre el mismo flujo con
 * el almacén local, que es el del despliegue real.
 */
const URL_BASE = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let directorio: string;
let ports: ReturnType<typeof partnerPorts>;
let servidor: ReturnType<typeof crearZavuFalso>;

/** Un Zavu mínimo: lo único que hace falta es que devuelva una invitación. */
function crearZavuFalso() {
  const invitaciones = new Map<string, Record<string, unknown>>();
  const original = globalThis.fetch;
  globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
    const url = String(entrada);
    // Lo primero que hace el flujo es comprobar el proyecto y el ambiente
    // (`/me`). Sin esto todo cae con PARTNER_RESOURCE_GONE y la prueba
    // parecería hablar del enlace cuando en realidad no llegó nunca ahí.
    if (url.endsWith('/me')) {
      return new Response(
        JSON.stringify({ project: { id: 'proy_de_prueba', name: 'Prueba' }, isTestMode: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/invitations') && init?.method === 'POST') {
      const id = `inv_${randomUUID().replaceAll('-', '')}`;
      // La forma exacta que exige `invitationFrom`: envuelta en `invitation`
      // y con `connectionType`. Sin eso el flujo queda en `ambiguous`, que es
      // «no sé si se creó» — otro estado, otra prueba.
      const cuerpo = {
        invitation: {
          id,
          connectionType: 'whatsapp_waba',
          status: 'pending',
          url: `https://dashboard.zavu.dev/invite/${id}`,
          expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        },
      };
      invitaciones.set(id, cuerpo);
      return new Response(JSON.stringify(cuerpo), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const m = /\/invitations\/([^/?]+)$/.exec(url);
    if (m && invitaciones.has(m[1]!)) {
      return new Response(JSON.stringify(invitaciones.get(m[1]!)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { restaurar: () => { globalThis.fetch = original; } };
}

beforeAll(async () => {
  pool = createPool(URL_BASE);
  await runMigrations(pool);
  directorio = await mkdtemp(join(tmpdir(), 'custodia-'));
  for (const [k, v] of Object.entries({
    ZAVU_PARTNER_PROJECT_ID: 'proy_de_prueba',
    ZAVU_PARTNER_API_URL: 'https://api.example.test',
    ZAVU_PARTNER_WEBHOOK_SECRET: 'firma_de_prueba',
    ZAVU_API_KEY: 'llave_de_prueba',
    ZAVU_API_BASE: 'https://zavu.example.test/v1',
    // Las dos que eligen el disco cifrado: es la custodia de ADR-0028 en v1.
    GOOGLE_SECRET_DIR: directorio,
    GOOGLE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    IAXTI_ENV: 'test',
  })) vi.stubEnv(k, v);
  ports = partnerPorts(() => true);
  // Explícito aunque `partnerPorts` ya la elija: si mañana cambia el defecto,
  // esta prueba tiene que seguir midiendo la custodia local.
  ports.secrets = createLocalSecretStore({ directorio, clave: Buffer.alloc(32, 7).toString('base64') });
  servidor = crearZavuFalso();
});

afterAll(async () => {
  servidor?.restaurar();
  await pool?.end();
  if (directorio) await rm(directorio, { recursive: true, force: true });
});

describe('el enlace del alta con la custodia del VPS (#1253)', () => {
  it('se guarda y se puede volver a leer', async () => {
    const tenant = await withTenant(pool, randomUUID(), (c) => createTenant(c, { name: 'Barbería de prueba' }));
    const actor = { tenantId: tenant.id, actor: randomUUID(), actorKind: 'user' as const, key: randomUUID() };

    const inicio = await startPartnerInvitation(pool, actor, ports);
    expect(inicio.phase).toBe('pending');

    // Lo que fallaba: `partnerStatus` lee el enlace de vuelta y lo rechazaba
    // por malformado. Que `url` venga es la prueba entera.
    const estado = await partnerStatus(pool, tenant.id, ports, actor);
    expect(estado.url).toMatch(/^https:\/\/dashboard\.zavu\.dev\/invite\//);

    // Y la referencia guardada es la del disco, no la de Secret Manager: si
    // esto dejara de ser cierto, la prueba estaría midiendo el otro backend
    // otra vez sin que nadie lo note.
    const fila = await pool.query(
      'SELECT url_ref FROM whatsapp_partner_invitations WHERE tenant_id=$1',
      [tenant.id],
    );
    expect(fila.rows[0].url_ref).toMatch(/^custodia-local\/secrets\//);
  });

  /**
   * Lo que el validador SÍ tiene que seguir rechazando. Aflojar el prefijo
   * del backend no puede aflojar de quién es el secreto: el nombre lleva el
   * id de la invitación, y es lo único que impide que un negocio lea el
   * enlace de otro.
   */
  it('no acepta la referencia de OTRA invitación, aunque el formato sea válido', async () => {
    const a = await withTenant(pool, randomUUID(), (c) => createTenant(c, { name: 'Negocio A' }));
    const b = await withTenant(pool, randomUUID(), (c) => createTenant(c, { name: 'Negocio B' }));
    const actorA = { tenantId: a.id, actor: randomUUID(), actorKind: 'user' as const, key: randomUUID() };
    const actorB = { tenantId: b.id, actor: randomUUID(), actorKind: 'user' as const, key: randomUUID() };
    await startPartnerInvitation(pool, actorA, ports);
    await startPartnerInvitation(pool, actorB, ports);

    const refA = (
      await pool.query('SELECT url_ref FROM whatsapp_partner_invitations WHERE tenant_id=$1', [a.id])
    ).rows[0].url_ref as string;
    await pool.query('UPDATE whatsapp_partner_invitations SET url_ref=$2 WHERE tenant_id=$1', [b.id, refA]);

    await expect(partnerStatus(pool, b.id, ports, actorB)).rejects.toMatchObject({
      code: 'PARTNER_LINK_UNAVAILABLE',
    });
  });
});
