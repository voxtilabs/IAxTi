import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createWidget, setWidgetActive } from '@iaxti/module-webchat';
import type { Widget } from '@iaxti/module-webchat';
import { Queue } from 'bullmq';
import { redisConnection } from '@iaxti/core';
import { createApp } from '../src/main';

// El lado público del webchat (#46): token + dominio como autenticación.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const PAGE = 'https://clienta.cl/servicios';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let widget: Widget;

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/webchat/${widget.id}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: PAGE, ...body }),
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-webchat-api') RETURNING id");
  tenant = t.rows[0].id;
  widget = await withTenant(admin, tenant, (c) =>
    createWidget(c, { tenantId: tenant, allowedDomain: 'clienta.cl' }),
  );
  app = await createApp({ jwtVerify: null, resolveRole: null });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  // La cola `agents` es COMPARTIDA con los demás tests del monorepo, y
  // ahora cada mensaje de webchat encola una sugerencia (#438). Un job
  // olvidado se lo lleva el worker de otro test —que cuenta cuántas veces
  // se llamó— y lo rompe por un motivo que no tiene nada que ver con lo
  // suyo. Se borran los de ESTE tenant, no la cola entera.
  const cola = new Queue('agents', { connection: redisConnection() });
  for (const job of await cola.getJobs(['waiting', 'delayed', 'completed', 'failed'])) {
    if ((job.data as { tenantId?: string } | undefined)?.tenantId === tenant) {
      await cola.remove(job.id!).catch(() => undefined);
    }
  }
  await cola.close();

  await app.close();
  for (const tabla of ['webchat_sessions', 'webchat_widgets', 'assignments', 'messages', 'conversations', 'contacts', 'channel_accounts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('webchat público', () => {
  it('fuera del dominio permitido: 404 mudo; dentro: config y sesión', async () => {
    const ajeno = await fetch(`${base}/webchat/${widget.id}/config?page=https://otro.cl`);
    expect(ajeno.status).toBe(404);

    const config = await fetch(`${base}/webchat/${widget.id}/config?page=${encodeURIComponent(PAGE)}`);
    expect(config.status).toBe(200);
    expect((await config.json()).welcomeMessage).toContain('Hola');
  });

  it('el flujo completo por HTTP: anónimo → identidad → bandeja → sondeo', async () => {
    const sesion = await (await post('/sessions', {})).json();
    expect(sesion.sessionId).toBeTruthy();

    const primero = await (await post('/messages', { sessionId: sesion.sessionId, body: 'Hola' })).json();
    expect(primero.status).toBe('pending');

    const identificado = await (
      await post('/messages', {
        sessionId: sesion.sessionId,
        body: 'Quiero agendar',
        visitor: { name: 'Pedro Web', phone: '+56 9 5555 0001' },
      })
    ).json();
    expect(identificado.status).toBe('delivered');

    const contacto = await admin.query(
      `SELECT name, origin FROM contacts WHERE tenant_id = $1 AND phone = '+56955550001'`,
      [tenant],
    );
    expect(contacto.rows[0]).toEqual({ name: 'Pedro Web', origin: 'webchat' });

    const respuestas = await fetch(
      `${base}/webchat/${widget.id}/messages?page=${encodeURIComponent(PAGE)}&sessionId=${sesion.sessionId}`,
    );
    expect(respuestas.status).toBe(200);
    expect(await respuestas.json()).toEqual([]); // el equipo aún no responde
  });

  it('el widget apagado responde 404 (el historial queda en la bandeja)', async () => {
    await withTenant(admin, tenant, (c) =>
      setWidgetActive(c, { tenantId: tenant, widgetId: widget.id, active: false }),
    );
    expect((await post('/sessions', {})).status).toBe(404);
    await withTenant(admin, tenant, (c) =>
      setWidgetActive(c, { tenantId: tenant, widgetId: widget.id, active: true }),
    );
  });

  it('el mensaje del visitante pide sugerencia al copiloto (#438)', async () => {
    // WhatsApp y el simulador entran por la cola `inbound` y ES ESE worker
    // el que encola la sugerencia. El webchat escribe directo en la bandeja
    // —para que el visitante vea su mensaje al tiro— y se saltaba al
    // copiloto entero: el único canal que funciona sin proveedor era el
    // único sin asistente.
    const cola = new Queue('agents', { connection: redisConnection() });
    try {
      const sesion = await (await post('/sessions', {})).json();
      const res = await post('/messages', {
        sessionId: sesion.sessionId,
        body: '¿Tienen hora para mañana?',
        visitor: { name: 'Sugerencia', phone: '+56999000077' },
      });
      const cuerpo = await res.json();
      expect(cuerpo.status).toBe('delivered');
      expect(cuerpo.messageId).toBeTruthy();

      const job = await cola.getJob(`sg-${cuerpo.messageId}`);
      expect(job, 'el webchat no pidió sugerencia').toBeDefined();
      expect(job!.data).toMatchObject({
        moduleId: 'agents',
        conversationId: cuerpo.conversationId,
        messageId: cuerpo.messageId,
      });
    } finally {
      await cola.close();
    }
  });
});
