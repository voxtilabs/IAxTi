import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  DIAS_DE_REVISION_DEMORADA,
  aplicarEstadoDelProveedor,
  createTemplate,
  listTemplates,
  marcarEnviadaARevision,
} from '../application/plantillas';
import type { PlantillaBorrador } from '../domain/plantillas';

/**
 * Desde cuándo está en revisión (#552).
 *
 * `submitted_at` y `reviewed_at` se escribían —al mandar a revisión y cuando
 * Meta contesta— y ninguna consulta las devolvía: no estaban en el DTO y no
 * llegaban a la pantalla.
 *
 * Meta se demora días y la revisión es asíncrona: se manda y se espera. La
 * pantalla decía «en revisión» y no desde cuándo, y para quien atiende ésa es la
 * diferencia entre «la mandé ayer, espero» y «la mandé hace dos semanas, algo
 * pasó». Pasadas las 24 h de la ventana, una plantilla trabada es no poder
 * escribirle a nadie.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

const borrador = (name: string): PlantillaBorrador => ({
  name,
  language: 'es_CL',
  category: 'utility',
  body: 'Hola {{1}}, te recordamos tu hora.',
});

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query("INSERT INTO tenants (name) VALUES ('desde-cuando-revision') RETURNING id")
  ).rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM whatsapp_templates WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

/** Una plantilla en revisión, con la fecha de envío corrida atrás. */
async function enRevision(name: string, haceDias = 0): Promise<string> {
  const p = await en((c) => createTemplate(c, { tenantId: tenant, ...borrador(name) }));
  await en((c) => marcarEnviadaARevision(c, { tenantId: tenant, templateId: p.id }));
  if (haceDias > 0) {
    await admin.query(
      'UPDATE whatsapp_templates SET submitted_at = now() - make_interval(days => $2) WHERE id = $1',
      [p.id, haceDias],
    );
  }
  return p.id;
}

const traer = async (id: string) =>
  (await en((c) => listTemplates(c, tenant))).find((p) => p.id === id)!;

describe('desde cuándo está en revisión (#552)', () => {
  it('un borrador no tiene fecha de envío ni días: no está esperando nada', async () => {
    const p = await en((c) => createTemplate(c, { tenantId: tenant, ...borrador('borrador suelto') }));
    const leida = await traer(p.id);
    expect(leida.submittedAt).toBeNull();
    expect(leida.diasEnRevision, 'null y no 0: «no está en revisión» no es «la mandé hoy»').toBeNull();
    expect(leida.revisionDemorada).toBe(false);
  });

  it('mandada hoy: trae la fecha y cero días', async () => {
    const id = await enRevision('mandada hoy');
    const p = await traer(id);
    expect(p.submittedAt, 'se escribía y no se devolvía').toBeInstanceOf(Date);
    expect(p.diasEnRevision).toBe(0);
    expect(p.revisionDemorada).toBe(false);
  });

  it('un día antes del umbral todavía no se marca demorada', async () => {
    // El control del caso de abajo: si todo se marcara demorado, la marca no
    // diría nada y se aprendería a ignorarla.
    const id = await enRevision('casi demorada', DIAS_DE_REVISION_DEMORADA - 1);
    const p = await traer(id);
    expect(p.diasEnRevision).toBe(DIAS_DE_REVISION_DEMORADA - 1);
    expect(p.revisionDemorada).toBe(false);
  });

  it('pasado el umbral sí, que es lo que distingue «hace 12 días» de «hace 2»', async () => {
    const id = await enRevision('bien demorada', 12);
    const p = await traer(id);
    expect(p.diasEnRevision).toBe(12);
    expect(p.revisionDemorada).toBe(true);
  });

  it('cuando Meta contesta, queda la fecha de la revisión y se dejan de contar días', async () => {
    const id = await enRevision('aprobada', 5);
    const antes = await traer(id);
    await en((c) =>
      aplicarEstadoDelProveedor(c, {
        tenantId: tenant,
        name: antes.name,
        language: antes.language,
        status: 'approved',
      }),
    );
    const p = await traer(id);
    expect(p.reviewedAt, 'se escribía y no se devolvía').toBeInstanceOf(Date);
    expect(p.status).toBe('approved');
    expect(p.diasEnRevision, 'ya no espera: contar días sería mentir').toBeNull();
    expect(p.revisionDemorada).toBe(false);
  });

  it('una rechazada tampoco cuenta días, aunque haya esperado mucho', async () => {
    const id = await enRevision('rechazada', 9);
    const antes = await traer(id);
    await en((c) =>
      aplicarEstadoDelProveedor(c, {
        tenantId: tenant,
        name: antes.name,
        language: antes.language,
        status: 'rejected',
        reason: 'el cuerpo parece promocional',
      }),
    );
    const p = await traer(id);
    expect(p.status).toBe('rejected');
    expect(p.reviewedAt).toBeInstanceOf(Date);
    expect(p.diasEnRevision).toBeNull();
    expect(p.rejectionReason).toContain('promocional');
  });

  it('el umbral está declarado en un solo lugar', () => {
    // Si la pantalla lo calculara por su cuenta, el día que uno cambie de
    // criterio la insignia y el texto dirían cosas distintas de la misma
    // plantilla.
    expect(DIAS_DE_REVISION_DEMORADA).toBeGreaterThan(0);
    expect(DIAS_DE_REVISION_DEMORADA).toBeLessThan(8);
  });
});
