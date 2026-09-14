import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { writeAudit } from '../src/write';
import { searchAudit, searchAuditGlobal } from '../src/search';
import { auditToCsv, signExport, verifyExport, COLUMNAS_EXPORT } from '../src/export';

// Exportación firmada y búsqueda global (#72). Un export que el auditor no
// puede verificar no prueba nada; una firma que se inventa cuando no hay
// secreto es peor que no firmar.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const a = await admin.query("INSERT INTO tenants (name) VALUES ('export-a') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('export-b') RETURNING id");
  tenantA = a.rows[0].id;
  tenantB = b.rows[0].id;
  await withTenant(admin, tenantA, (c) =>
    writeAudit(c, {
      tenantId: tenantA,
      actor: 'user-a',
      actorKind: 'user',
      action: 'contact.updated',
      resource: 'contact',
      resourceId: 'k-1',
      result: 'ok',
      ip: '190.100.1.5',
      metadata: { campo: 'nombre, con coma' },
    }),
  );
  await withTenant(admin, tenantA, (c) =>
    writeAudit(c, {
      tenantId: tenantA,
      actor: 'user-a',
      actorKind: 'user',
      action: 'deal.deleted',
      resource: 'deal',
      result: 'denied',
      ip: '190.100.1.9',
    }),
  );
  await withTenant(admin, tenantB, (c) =>
    writeAudit(c, {
      tenantId: tenantB,
      actor: 'admin-b',
      actorKind: 'superadmin',
      action: 'tenant.suspended',
      resource: 'tenant',
      result: 'ok',
    }),
  );
});

afterAll(async () => {
  await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM audit_log WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
  await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
  await admin.end();
});

/** Parser mínimo de una fila CSV: respeta comillas y comillas dobladas. */
function parsearFila(fila: string): string[] {
  const celdas: string[] = [];
  let actual = '';
  let entreComillas = false;
  for (let i = 0; i < fila.length; i++) {
    const ch = fila[i];
    if (entreComillas) {
      if (ch === '"' && fila[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (ch === '"') {
        entreComillas = false;
      } else {
        actual += ch;
      }
    } else if (ch === '"') {
      entreComillas = true;
    } else if (ch === ',') {
      celdas.push(actual);
      actual = '';
    } else {
      actual += ch;
    }
  }
  celdas.push(actual);
  return celdas;
}

describe('filtros nuevos del explorador (#72)', () => {
  it('filtra por IP y por resultado dentro del tenant', async () => {
    const porIp = await withTenant(admin, tenantA, (c) => searchAudit(c, { ip: '190.100.1.9' }));
    expect(porIp).toHaveLength(1);
    expect(porIp[0].action).toBe('deal.deleted');
    // La IP sale como texto, no como el `inet` crudo de Postgres.
    expect(porIp[0].ip).toBe('190.100.1.9');

    const denegados = await withTenant(admin, tenantA, (c) => searchAudit(c, { result: 'denied' }));
    expect(denegados).toHaveLength(1);
    expect(await withTenant(admin, tenantA, (c) => searchAudit(c, { result: 'no-existe' }))).toHaveLength(0);
  });
});

describe('búsqueda global del SuperAdmin (#72)', () => {
  it('cruza tenants y sabe acotarse a uno', async () => {
    const client = await admin.connect();
    try {
      const todos = await searchAuditGlobal(client, { action: 'tenant.suspended' });
      expect(todos.some((f) => f.tenant_id === tenantB)).toBe(true);

      const soloA = await searchAuditGlobal(client, { tenantId: tenantA });
      expect(soloA.length).toBeGreaterThanOrEqual(2);
      expect(soloA.every((f) => f.tenant_id === tenantA)).toBe(true);
      // El tenant viaja en cada fila: sin eso, el explorador global miente.
      expect(soloA[0].tenant_id).toBe(tenantA);
    } finally {
      client.release();
    }
  });
});

describe('exportación firmada (#72)', () => {
  it('el CSV tiene columnas fijas y no se corre con comas ni comillas', () => {
    const csv = auditToCsv([
      {
        id: 1,
        actor: 'a',
        action: 'x',
        resource: 'dijo "hola", y se fue',
        metadata: { nota: 'con, coma' },
      },
    ]);
    const [cabecera, fila] = csv.split('\n');
    expect(cabecera).toBe(COLUMNAS_EXPORT.join(','));
    // Una comilla dentro del dato se dobla, y ni la coma ni la comilla corren
    // las columnas: se parsea de vuelta y tiene que salir lo mismo que entró.
    const celdas = parsearFila(fila);
    expect(celdas).toHaveLength(COLUMNAS_EXPORT.length);
    expect(celdas[COLUMNAS_EXPORT.indexOf('resource')]).toBe('dijo "hola", y se fue');
    expect(JSON.parse(celdas[COLUMNAS_EXPORT.indexOf('metadata')])).toEqual({ nota: 'con, coma' });
  });

  it('firma, verifica y detecta el documento tocado', () => {
    const filas = [{ id: 1, actor: 'a', action: 'contact.updated' }];
    const doc = signExport(filas, 'json', { secret: 'secreto-auditor', generatedAt: 'fijo' });
    expect(doc.rows).toBe(1);
    expect(doc.signature).not.toBeNull();
    expect(verifyExport(doc, 'secreto-auditor')).toBe(true);
    // Otro secreto no vale, y el contenido alterado tampoco.
    expect(verifyExport(doc, 'otro')).toBe(false);
    expect(verifyExport({ ...doc, payload: doc.payload + ' ' }, 'secreto-auditor')).toBe(false);
    // Firmar dos veces lo mismo da lo mismo: el documento es reproducible.
    expect(signExport(filas, 'json', { secret: 'secreto-auditor', generatedAt: 'fijo' })).toEqual(doc);
  });

  it('sin secreto la firma sale null A LA VISTA, nunca inventada', () => {
    const doc = signExport([{ id: 1 }], 'csv', { secret: null });
    expect(doc.signature).toBeNull();
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Un documento sin firma no pasa la verificación por descarte.
    expect(verifyExport(doc, 'cualquiera')).toBe(false);
  });
});
