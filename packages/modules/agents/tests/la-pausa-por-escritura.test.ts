import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { setConversationMode, conversationMode, pausarAutonomoPorEscritura, restaurarPausasVencidas } from '../application/autonomous';

/**
 * La regla de #1416: escribir de humano apaga la IA, con duración elegida.
 *
 * Lo que se prueba es el ESTADO y el regreso: la pausa deja `assist` con su
 * vencimiento, «hasta volver» no vence nunca, y el barrido restaura solo las
 * vencidas — una conversación pausada con futuro no la toca.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let admin: Pool;
let tenant: string;
const convs: string[] = [];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('pausa-1416') RETURNING id")).rows[0].id;
  // `conversations` exige un contacto: uno compartido alcanza para las cuatro.
  const contacto = (await admin.query('INSERT INTO contacts (tenant_id, phone) VALUES ($1, $2) RETURNING id', [tenant, '+56900001416'])).rows[0].id;
  for (let i = 0; i < 4; i++) {
    convs.push((await admin.query('INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, $3) RETURNING id', [tenant, contacto, 'simulador'])).rows[0].id);
  }
});

afterAll(async () => {
  // Los audit del pulso pueden llegar DESPUÉS de la última prueba (el barrido
  // corre cada minuto sobre todos los tenants): una sola pasada, sin catch,
  // y el tenant al final de todo.
  await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agent_conversation_modes WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

const modo = (c: string) => withTenant(admin, tenant, (cl) => conversationMode(cl, tenant, c));

describe('la pausa por escritura', () => {
  it('una hora: assist con vencimiento a futuro, y el barrido NO la toca antes de tiempo', async () => {
    const c = convs[0]!;
    await withTenant(admin, tenant, (cl) => setConversationMode(cl, { tenantId: tenant, conversationId: c, mode: 'autonomous', actor: 'duena' }));
    const { vuelveEl } = await withTenant(admin, tenant, (cl) =>
      pausarAutonomoPorEscritura(cl, { tenantId: tenant, conversationId: c, duracion: '1h', actor: 'duena' }),
    );
    expect(vuelveEl).toBeInstanceOf(Date);
    expect(vuelveEl!.getTime()).toBeGreaterThan(Date.now());
    expect(await modo(c)).toBe('assist');
    expect(await withTenant(admin, tenant, (cl) => restaurarPausasVencidas(cl, tenant))).toBe(0);
    expect(await modo(c)).toBe('assist');
  });

  it('vencida: el barrido la devuelve a autonomous y audita el regreso', async () => {
    const c = convs[1]!;
    await withTenant(admin, tenant, (cl) => setConversationMode(cl, { tenantId: tenant, conversationId: c, mode: 'autonomous', actor: 'duena' }));
    await admin.query(
      `INSERT INTO agent_conversation_modes (tenant_id, conversation_id, mode, set_by, vuelve_el)
       VALUES ($1, $2, 'assist', 'duena', now() - interval '1 minute')
       ON CONFLICT (tenant_id, conversation_id) DO UPDATE SET mode = 'assist', vuelve_el = now() - interval '1 minute'`,
      [tenant, c],
    );
    expect(await withTenant(admin, tenant, (cl) => restaurarPausasVencidas(cl, tenant))).toBe(1);
    expect(await modo(c)).toBe('autonomous');
    const audit = await admin.query(
      `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'agents.conversation_mode.restaurado' AND resource_id = $2`,
      [tenant, c],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('hasta volver: sin vencimiento, el barrido no la toca', async () => {
    const c = convs[2]!;
    await withTenant(admin, tenant, (cl) => setConversationMode(cl, { tenantId: tenant, conversationId: c, mode: 'autonomous', actor: 'duena' }));
    const { vuelveEl } = await withTenant(admin, tenant, (cl) =>
      pausarAutonomoPorEscritura(cl, { tenantId: tenant, conversationId: c, duracion: 'hasta_volver', actor: 'duena' }),
    );
    expect(vuelveEl).toBeNull();
    expect(await withTenant(admin, tenant, (cl) => restaurarPausasVencidas(cl, tenant))).toBe(0);
    expect(await modo(c)).toBe('assist');
  });

  it('una conversación sin modo autónomo no se pausa: la regla solo baja AUTONOMOUS', async () => {
    const c = convs[3]!;
    // Sin fila de modo: nunca se puso autónomo. La pausa igual escribe assist
    // (inofensivo), pero el llamador de la API SOLO la invoca si había
    // autonomous — eso lo prueba la ruta; acá se fija el estado.
    expect(await modo(c)).toBeNull();
    await withTenant(admin, tenant, (cl) =>
      pausarAutonomoPorEscritura(cl, { tenantId: tenant, conversationId: c, duracion: '1h', actor: 'duena' }),
    );
    expect(await modo(c)).toBe('assist');
  });
});
