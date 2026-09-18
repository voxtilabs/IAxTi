import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import {
  DIAS_HASTA_AVISAR,
  DIAS_HASTA_BORRAR,
  avisarBorradoPendiente,
  tenantsPorBorrar,
} from '../application/fin-de-ciclo';

/**
 * El final del ciclo de vida del tenant (#218, SPEC §6).
 *
 * La decisión tomada: **el sistema avisa, una persona borra**. El borrado es
 * irreversible y se lleva datos de los clientes de nuestro cliente; un error
 * de fecha o una factura pagada que no se registró terminan en datos que no
 * vuelven.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const creados: string[] = [];

async function tenantSuspendidoHace(dias: number, nombre: string): Promise<string> {
  const t = await admin.query(
    `INSERT INTO tenants (name, state, state_since)
     VALUES ($1, 'suspended', now() - make_interval(days => $2)) RETURNING id`,
    [nombre, dias],
  );
  creados.push(t.rows[0].id);
  return t.rows[0].id;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  await admin.end();
});

describe('la cola de borrado', () => {
  it('entra quien lleva suspendido más del plazo de aviso, no antes', async () => {
    const reciente = await tenantSuspendidoHace(DIAS_HASTA_AVISAR - 10, 'recien-suspendido');
    const viejo = await tenantSuspendidoHace(DIAS_HASTA_AVISAR + 5, 'lleva-rato');

    const cola = await tenantsPorBorrar(admin);
    const ids = cola.map((x) => x.id);
    expect(ids).toContain(viejo);
    expect(ids).not.toContain(reciente);
  });

  it('marca cuál ya pasó el plazo del SPEC, sin borrarlo', async () => {
    const pasado = await tenantSuspendidoHace(DIAS_HASTA_BORRAR + 3, 'pasado-de-plazo');
    const cola = await tenantsPorBorrar(admin);
    const fila = cola.find((x) => x.id === pasado)!;
    expect(fila.borrable).toBe(true);

    // Y sigue existiendo, suspendido: el sistema no borra.
    const t = await admin.query('SELECT state FROM tenants WHERE id = $1', [pasado]);
    expect(t.rows[0].state).toBe('suspended');
  });

  it('el que está dentro del plazo aparece pero no es borrable', async () => {
    const dentro = await tenantSuspendidoHace(DIAS_HASTA_AVISAR + 2, 'dentro-del-plazo');
    const fila = (await tenantsPorBorrar(admin)).find((x) => x.id === dentro)!;
    expect(fila.borrable).toBe(false);
    expect(fila.diasSuspendido).toBeGreaterThanOrEqual(DIAS_HASTA_AVISAR);
  });
});

describe('el aviso', () => {
  it('se manda una vez y deja rastro', async () => {
    const t = await tenantSuspendidoHace(DIAS_HASTA_AVISAR + 1, 'para-avisar');
    const r = await avisarBorradoPendiente(admin);
    expect(r.avisados).toBeGreaterThanOrEqual(1);

    const fila = await admin.query('SELECT deletion_warned_at FROM tenants WHERE id = $1', [t]);
    expect(fila.rows[0].deletion_warned_at).not.toBeNull();

    const rastro = await admin.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.deletion_warned'`,
      [t],
    );
    expect(rastro.rowCount).toBe(1);

    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'tenant.deletion_warned'`,
      [t],
    );
    expect(evento.rowCount).toBe(1);
    expect(evento.rows[0].payload.diasRestantes).toBeLessThanOrEqual(DIAS_HASTA_BORRAR - DIAS_HASTA_AVISAR);
  });

  it('la segunda pasada del barrido no vuelve a avisar', async () => {
    // Un aviso que se repite todos los días es ruido, y el ruido se ignora
    // — lo contrario de lo que este aviso busca.
    const antes = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'tenant.deletion_warned'`,
    );
    await avisarBorradoPendiente(admin);
    const despues = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'tenant.deletion_warned'`,
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it('si el tenant volvió a la vida entre la consulta y el aviso, no se le avisa', async () => {
    const t = await tenantSuspendidoHace(DIAS_HASTA_AVISAR + 1, 'reactivado-a-tiempo');
    await admin.query("UPDATE tenants SET state = 'active' WHERE id = $1", [t]);
    await avisarBorradoPendiente(admin);
    const fila = await admin.query('SELECT deletion_warned_at FROM tenants WHERE id = $1', [t]);
    // Se relee dentro de la transacción justamente para esto.
    expect(fila.rows[0].deletion_warned_at).toBeNull();
  });
});

describe('la decisión, escrita donde se pueda romper', () => {
  it('NADA en el código pone un tenant en deleted solo', () => {
    // Si alguien agrega un `state = 'deleted'` automático, esto se cae y hay
    // que discutir la decisión, no el test. Borrar sigue siendo del
    // SuperAdmin, a mano, con su rastro.
    const raiz = join(__dirname, '../../../..');
    const sospechosos: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.next', '.git', '.turbo'].includes(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) recorrer(p);
        else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
          const txt = readFileSync(p, 'utf8');
          // El panel del SuperAdmin sí puede: es una persona decidiendo.
          if (p.includes('tenants-admin.ts')) continue;
          if (/changeTenantState\([^)]*'deleted'/.test(txt) || /state = 'deleted'/.test(txt)) {
            sospechosos.push(p.slice(raiz.length + 1));
          }
        }
      }
    };
    recorrer(join(raiz, 'packages'));
    recorrer(join(raiz, 'apps'));
    expect(sospechosos, `alguien borra tenants sin pasar por una persona: ${sospechosos}`).toEqual([]);
  });
});
