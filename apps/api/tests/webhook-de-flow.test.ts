import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { Queue } from 'bullmq';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { addProvider } from '@iaxti/module-payments';
import { createApp } from '../src/main';

// El webhook de Flow (#61). Flow confirma con un POST x-www-form-urlencoded
// que lleva SOLO el token: no manda firma, ni cabecera, ni secreto. El guard
// exigía un secreto configurado igual que a un proveedor que firma —y el
// secreto es opcional en todas partes—, así que se llegaba a "Flow en verde"
// siguiendo la guía, el cliente pagaba, Flow recibía 401 y, según su doc, "la
// transacción se mantendrá exitosa": tarjeta cobrada, plata abonada al
// comercio, y en IAxTi nada. Para Flow la autenticidad no está en el webhook:
// la resuelve el worker con getStatus firmado antes de registrar el pago.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let flow: string;
let simulado: string;
let queue: Queue;
const jobIds: string[] = [];

function confirmar(providerId: string, body: string): Promise<Response> {
  return fetch(`${base}/webhooks/payments/${providerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('api-webhook-flow') RETURNING id");
  tenant = t.rows[0].id;
  // A propósito SIN webhookSecretRef: así queda un proveedor de Flow
  // siguiendo la guía de configuración, que no menciona ningún secreto.
  const f = await withTenant(admin, tenant, (c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'flow',
      name: 'Flow sandbox',
      credentialRef: 'FLOW_WEBHOOK_CRED',
      actor: 'test',
    }),
  );
  flow = f.id;
  const s = await withTenant(admin, tenant, (c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'simulado',
      name: 'Simulador',
      credentialRef: 'PAGOS_WEBHOOK_CRED',
      actor: 'test',
    }),
  );
  simulado = s.id;
  queue = new Queue('inbound', { connection: redisConnection() });
  app = await createApp({ jwtVerify: null, resolveRole: null });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const id of jobIds) await queue.remove(id).catch(() => {});
  await queue.close();
  await admin.query('DELETE FROM payment_providers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('POST /webhooks/payments/:providerId con Flow', () => {
  it('la confirmación de Flow —solo el token, sin firma ni secreto— se encola', async () => {
    const res = await confirmar(flow, 'token=tok-de-flow-608');
    expect(res.status).toBe(201);
    expect((await res.json()).queued).toBe(true);

    const id = `pay-${flow}-tok-de-flow-608`;
    jobIds.push(id);
    const job = await queue.getJob(id);
    expect(job?.data.providerKind).toBe('flow');
    // El token viaja para que el worker pregunte el estado; el webhook no
    // decide nada por sí mismo.
    expect((job?.data.pago as { providerPaymentId: string }).providerPaymentId).toBe('tok-de-flow-608');
    expect((job?.data.pago as { status: string }).status).toBe('pending');
    // Flow avisa una sola vez: el job tiene que aguantar un rato de reintentos.
    expect(job?.opts.attempts).toBeGreaterThan(5);
  });

  it('un cuerpo sin token no se entiende y no encola nada', async () => {
    const res = await confirmar(flow, 'otra_cosa=1');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('al proveedor que SÍ firma se le sigue exigiendo la firma', async () => {
    // El simulador firma el cuerpo con HMAC: sin firma válida, 401. Levantar
    // la exigencia para Flow no abre la puerta de los demás.
    const res = await fetch(`${base}/webhooks/payments/${simulado}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Iaxti-Pay-Signature': 'chamullo' },
      body: JSON.stringify({ linkId: '00000000-0000-0000-0000-000000000000', status: 'paid' }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_SIGNATURE');
  });
});
