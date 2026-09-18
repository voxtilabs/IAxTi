import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import type { EventEnvelope } from '@iaxti/core';
import { handleNotifiableEvent, notificationConsumers } from '../application/consumers';
import { listNotifications } from '../application/notifications';

/**
 * El aviso de que la cuenta cambió de estado (issue 273).
 *
 * `tenant.state_changed` se publicaba desde el barrido de facturación —al
 * vencer la prueba y al suspender a los 30 días— y no lo consumía nadie. A
 * un negocio se le acababa la prueba, la cuenta pasaba a solo lectura,
 * dejaba de poder escribirle a sus clientes, y se enteraba al intentarlo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const duena = randomUUID(); // ADMIN
const vendedor = randomUUID(); // USER

const evento = (to: string, from = 'trial'): EventEnvelope =>
  ({
    name: 'tenant.state_changed',
    tenantId: tenant,
    payload: { from, to, motivo: 'prueba vencida' },
    actor: 'system',
  }) as unknown as EventEnvelope;

/** `listNotifications` devuelve `{items, unread}`: acá interesan los items. */
const avisosDe = async (userId: string) =>
  (await withTenant(admin, tenant, (c) => listNotifications(c, tenant, userId))).items;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('estado-cuenta') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, rol] of [
    [duena, 'ADMIN'],
    [vendedor, 'USER'],
  ] as const) {
    await admin.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE tenant_id IS NULL AND name = $3`,
      [tenant, userId, rol],
    );
  }
});

afterAll(async () => {
  await admin.end();
});

describe('cuando la cuenta cambia de estado', () => {
  it('el evento tiene consumidor: antes se publicaba y no lo oía nadie', () => {
    const nombres = notificationConsumers().map((c) => c.event);
    expect(nombres).toContain('tenant.state_changed');
  });

  it('el ADMIN se entera de que quedó en solo lectura, y sabe qué hacer', async () => {
    await withTenant(admin, tenant, (c) => handleNotifiableEvent(evento('read_only'), c, {}));

    const avisos = await avisosDe(duena);
    expect(avisos).toHaveLength(1);
    expect(avisos[0].type).toBe('estado_cuenta');
    expect(avisos[0].title).toBe('Tu cuenta quedó en solo lectura');
    // Qué pasó Y qué hacer: un aviso que solo informa deja al dueño mirando
    // la pantalla sin saber por dónde salir.
    expect(avisos[0].body).toMatch(/Elige un plan/);
    expect(avisos[0].link).toBe('/ajustes/plan');
  });

  it('al vendedor no se le avisa: no es suyo el problema ni la solución', async () => {
    expect(await avisosDe(vendedor)).toHaveLength(0);
  });

  it('la suspensión dice que los datos siguen ahí', async () => {
    await withTenant(admin, tenant, (c) =>
      handleNotifiableEvent(evento('suspended', 'read_only'), c, {}),
    );
    const avisos = await avisosDe(duena);
    const suspension = avisos.find((a) => a.title === 'Tu cuenta quedó suspendida');
    expect(suspension).toBeDefined();
    // Lo primero que piensa alguien al ver "suspendida" es que perdió todo.
    expect(suspension!.body).toMatch(/no se borra nada/);
  });

  it('un cambio que no le cambia la vida a nadie no suena la campana', async () => {
    const antes = (await avisosDe(duena)).length;
    // Eligió plan durante la prueba: pasa a 'active'. Buena noticia, pero no
    // una interrupción. La campana vale por lo que interrumpe.
    await withTenant(admin, tenant, (c) => handleNotifiableEvent(evento('active'), c, {}));
    expect((await avisosDe(duena)).length).toBe(antes);
  });
});
