import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getUsage } from '@iaxti/module-organizations';
import { receiveInbound } from '../application/conversations';

/**
 * El medidor de conversaciones activas (SPEC §9 y la tabla de planes:
 * "Conversaciones activas / mes: tope del plan").
 *
 * La métrica `conversations` existía en `UsageMeter` y el panel del
 * SuperAdmin la muestra en la ficha de cada tenant. Nadie la incrementaba:
 * el número era siempre 0.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('uso-conversaciones') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

const entra = (phone: string, body: string, channel: 'whatsapp' | 'simulador' = 'whatsapp') =>
  withTenant(admin, tenant, (c) => receiveInbound(c, { tenantId: tenant, phone, channel, body }));

describe('conversaciones activas del ciclo', () => {
  it('cuenta UNA vez por conversación por más mensajes que lleguen', async () => {
    expect(await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'))).toBe(0);

    await entra('+56955551111', 'hola');
    expect(await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'))).toBe(1);

    // Tres mensajes más en la MISMA conversación: sigue siendo una.
    await entra('+56955551111', '¿siguen ahí?');
    await entra('+56955551111', 'hola?');
    expect(await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'))).toBe(1);

    // Otra persona: otra conversación activa.
    await entra('+56955552222', 'buenas');
    expect(await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'))).toBe(2);
  });

  it('el simulador no cuenta: es la herramienta de prueba, no un cliente', async () => {
    const antes = await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'));
    await entra('+56955553333', 'probando', 'simulador');
    expect(await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'))).toBe(antes);
  });

  it('al ciclo siguiente la misma conversación vuelve a contar', async () => {
    const antes = await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'));
    // Se finge que se contó en un ciclo viejo.
    await admin.query(
      "UPDATE conversations SET usage_period = '2001-01' WHERE tenant_id = $1",
      [tenant],
    );
    await entra('+56955551111', 'volví');
    expect(await withTenant(admin, tenant, (c) => getUsage(c, tenant, 'conversations'))).toBe(antes + 1);
  });
});
