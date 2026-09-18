import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import type { EventEnvelope } from '@iaxti/core';
import { advanceOnboarding, getTenant } from '../application/tenants';
import { onboardingConsumers, onboardingStatus } from '../application/onboarding';

/**
 * El onboarding avanza solo (SPEC §7). La máquina estaba entera y
 * `advanceOnboarding` no lo llamaba nadie: todos los tenants se quedaban en
 * `registered` para siempre.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

async function emitir(name: string, payload: Record<string, unknown> = {}) {
  const consumer = onboardingConsumers().find((c) => c.event === name);
  if (!consumer) throw new Error(`nadie escucha ${name}`);
  const envelope = {
    id: 1,
    name,
    tenantId: tenant,
    payload,
    actor: 'system',
    version: 1,
    occurredAt: new Date(),
  } as unknown as EventEnvelope;
  const client = await admin.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenant]);
    await consumer.handler(envelope, client);
  } finally {
    client.release();
  }
}

const estado = () => withTenant(admin, tenant, (c) => getTenant(c, tenant)).then((t) => t.onboardingState);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('onboarding-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('el onboarding avanza con lo que de verdad pasa', () => {
  it('nace en registered y cada evento lo mueve un paso', async () => {
    expect(await estado()).toBe('registered');

    await emitir('tenant.settings_changed');
    expect(await estado()).toBe('configured');

    await emitir('channel.connected', { kind: 'whatsapp' });
    expect(await estado()).toBe('whatsapp_connected');

    await emitir('knowledge.source_added');
    expect(await estado()).toBe('knowledge_added');

    await emitir('user.invited');
    expect(await estado()).toBe('team_invited');

    await emitir('message.sent');
    expect(await estado()).toBe('first_message');
  });

  it('un evento que llega tarde no hace retroceder nada', async () => {
    // El orden real no es el del diagrama: un negocio invita a su equipo
    // antes de conectar el número, y los eventos llegan cuando llegan.
    await emitir('tenant.settings_changed');
    await emitir('channel.connected', { kind: 'whatsapp' });
    expect(await estado()).toBe('first_message');
  });

  it('el simulador NO cuenta como conectar WhatsApp', async () => {
    // `channel.connected` se publica para cualquier canal, y el paso se
    // llama whatsapp_connected. El tenant que prende el simulador —que es
    // lo que uno hace para probar sin número, y lo que hace nuestra propia
    // demo— se saltaba el paso sin conectar WhatsApp. Y como los pasos no
    // retroceden, quedaba saltado PARA SIEMPRE: el flujo guiado no se lo
    // vuelve a pedir y el negocio nunca conecta su número.
    const t = await admin.query("INSERT INTO tenants (name) VALUES ('sim-test') RETURNING id");
    const otro = t.rows[0].id;
    const consumer = onboardingConsumers().find((c) => c.event === 'channel.connected')!;
    const client = await admin.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', otro]);
      for (const kind of ['simulador', 'webchat', 'instagram', 'messenger']) {
        await consumer.handler(
          { id: 1, name: 'channel.connected', tenantId: otro, payload: { kind }, actor: 'system', version: 1, occurredAt: new Date() } as unknown as EventEnvelope,
          client,
        );
      }
      const t1 = await getTenant(client, otro);
      expect(t1.onboardingState).toBe('registered');

      // Y el de verdad sí avanza.
      await consumer.handler(
        { id: 1, name: 'channel.connected', tenantId: otro, payload: { kind: 'whatsapp' }, actor: 'system', version: 1, occurredAt: new Date() } as unknown as EventEnvelope,
        client,
      );
      expect((await getTenant(client, otro)).onboardingState).toBe('whatsapp_connected');
    } finally {
      client.release();
      await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [otro]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [otro]);
    }
  });

  it('repetir un evento no falla ni cambia nada', async () => {
    await emitir('message.sent');
    await emitir('message.sent');
    expect(await estado()).toBe('first_message');
  });
});

describe('dónde va el negocio DE VERDAD (#56)', () => {
  const TODOS = ['crm', 'whatsapp', 'knowledge', 'identity', 'conversations'];

  async function estadoDe(tenantId: string, verificadores = {}, activos = TODOS) {
    return withTenant(admin, tenantId, (c) =>
      onboardingStatus(c, tenantId, { activeModules: activos, verificadores }),
    );
  }

  it('sin verificadores cae al historial, y lo dice', async () => {
    const t = await admin.query("INSERT INTO tenants (name) VALUES ('estado-1') RETURNING id");
    const id = t.rows[0].id;
    const e = await estadoDe(id);
    expect(e.estadoRegistrado).toBe('registered');
    expect(e.siguiente).toBe('configured');
    expect(e.completo).toBe(false);
    // Que un paso salga "no hecho" porque nadie lo miró no es lo mismo que
    // haberlo comprobado. El flujo guiado necesita saber cuál es cuál.
    expect(e.pasos.every((p) => p.fuente === 'historial')).toBe(true);
    await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
  });

  it('lo que HAY manda sobre lo que la columna recuerda', async () => {
    const t = await admin.query("INSERT INTO tenants (name) VALUES ('estado-2') RETURNING id");
    const id = t.rows[0].id;
    // La columna dice que el número está conectado…
    await withTenant(admin, id, (c) => advanceOnboarding(c, id, 'whatsapp_connected'));

    // …pero hoy no hay ninguno (se desconectó, o el paso se marcó por el
    // motivo equivocado). La columna no retrocede por diseño, así que sin
    // esto el flujo guiado deja de pedirlo para siempre.
    const e = await estadoDe(id, {
      whatsapp_connected: async () => ({ hecho: false, detalle: 'todavía no hay número conectado' }),
      configured: async () => ({ hecho: true, detalle: '1 embudo con 5 etapas' }),
    });
    const wa = e.pasos.find((p) => p.id === 'whatsapp_connected')!;
    expect(wa.hecho).toBe(false);
    expect(wa.fuente).toBe('verificado');
    expect(e.siguiente).toBe('whatsapp_connected');
    expect(e.desfase).toHaveLength(1);
    expect(e.desfase[0]).toContain('Conecta tu WhatsApp');
    expect(e.desfase[0]).toContain('todavía no hay número');
    await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
  });

  it('los pasos opcionales no impiden terminar', async () => {
    const t = await admin.query("INSERT INTO tenants (name) VALUES ('estado-3') RETURNING id");
    const id = t.rows[0].id;
    await withTenant(admin, id, (c) => advanceOnboarding(c, id, 'first_message'));
    // Sin catálogo ni equipo: el negocio de una persona igual está listo.
    const e = await estadoDe(id, {
      configured: async () => ({ hecho: true }),
      whatsapp_connected: async () => ({ hecho: true }),
      knowledge_added: async () => ({ hecho: false, detalle: 'sin catálogo' }),
      team_invited: async () => ({ hecho: false, detalle: 'por ahora estás tú solo' }),
    });
    expect(e.completo).toBe(true);
    expect(e.siguiente).toBeNull();
    expect(e.desfase).toEqual([]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
  });

  it('un paso de un módulo apagado no se le pide al negocio', async () => {
    const t = await admin.query("INSERT INTO tenants (name) VALUES ('estado-4') RETURNING id");
    const id = t.rows[0].id;
    // Sin `whatsapp`: mandarlo a conectar un número que este tenant no
    // puede conectar es mandarlo a una pared.
    const e = await estadoDe(id, { configured: async () => ({ hecho: true }) }, ['crm', 'conversations']);
    const wa = e.pasos.find((p) => p.id === 'whatsapp_connected')!;
    expect(wa.bloqueado).toBe(true);
    expect(e.siguiente).toBe('first_message');
    await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
  });

  it('un verificador que revienta no tumba la pantalla', async () => {
    const t = await admin.query("INSERT INTO tenants (name) VALUES ('estado-5') RETURNING id");
    const id = t.rows[0].id;
    const e = await estadoDe(id, {
      configured: async () => {
        throw new Error('la base del otro módulo se cayó');
      },
    });
    // Cae al historial en vez de dejar al negocio sin saber dónde va.
    expect(e.pasos.find((p) => p.id === 'configured')!.fuente).toBe('historial');
    await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
  });
});
