import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  exportarTenant,
  FUERA_DE_LA_EXPORTACION,
  TABLAS_EXPORTADAS,
} from '../application/exportacion';

/**
 * La exportación completa del tenant (issue 222). Lo que se prueba acá no es
 * que exporte: es que NO exporte lo de otro negocio y NO exporte un secreto.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let mio: string;
let ajeno: string;
let secretoInvitacion: string;
let secretoLlave: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const a = await admin.query("INSERT INTO tenants (name) VALUES ('export-mio') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('export-ajeno') RETURNING id");
  mio = a.rows[0].id;
  ajeno = b.rows[0].id;

  for (const [tenant, nombre, fono] of [
    [mio, 'Clienta mía', '+56933330001'],
    [ajeno, 'Clienta ajena', '+56933330002'],
  ] as const) {
    const c = await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, $2, $3, 'whatsapp') RETURNING id`,
      [tenant, nombre, fono],
    );
    const conv = await admin.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`,
      [tenant, c.rows[0].id],
    );
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind, attachments)
       VALUES ($1, $2, 'in', 'texto', $3, 'contact', $4::jsonb)`,
      [tenant, conv.rows[0].id, `mensaje de ${nombre}`, `[{"key":"${tenant}/wa/foto.jpg"}]`],
    );
  }

  // Un secreto de cada tipo, para comprobar que ninguno sale. El token es
  // único en la tabla: se le pega el id del tenant para poder correr el test
  // más de una vez contra la misma base.
  secretoInvitacion = `token-secretisimo-${mio}`;
  secretoLlave = `hash-secretisimo-${mio}`;
  await admin.query(
    `INSERT INTO invitations (tenant_id, email, role_name, token, expires_at)
     VALUES ($1, 'invitada@test.cl', 'USER', $2, now() + interval '7 days')`,
    [mio, secretoInvitacion],
  );
  await admin
    .query(
      `INSERT INTO api_keys (tenant_id, name, key_hash, scopes) VALUES ($1, 'integración', $2, '{}')`,
      [mio, secretoLlave],
    )
    .catch(() => undefined);
});

afterAll(async () => {
  await admin.end();
});

describe('exportación del tenant (issue 222)', () => {
  it('se lleva lo suyo: contactos, conversaciones y mensajes', async () => {
    const e = await withTenant(admin, mio, (c) => exportarTenant(c, { tenantId: mio }));
    expect(e.resumen.contacts).toBe(1);
    expect(e.resumen.messages).toBe(1);
    expect(JSON.stringify(e.datos.messages)).toContain('Clienta mía');
    expect(e.adjuntos).toEqual([`${mio}/wa/foto.jpg`]);
    expect(e.truncadas).toEqual([]);
  });

  it('JAMÁS lo de otro negocio', async () => {
    const e = await withTenant(admin, mio, (c) => exportarTenant(c, { tenantId: mio }));
    const todo = JSON.stringify(e);
    expect(todo).not.toContain('Clienta ajena');
    expect(todo).not.toContain('+56933330002');
    expect(todo).not.toContain(ajeno);
  });

  it('JAMÁS un secreto', async () => {
    const e = await withTenant(admin, mio, (c) => exportarTenant(c, { tenantId: mio }));
    const todo = JSON.stringify(e);
    expect(todo).not.toContain(secretoInvitacion);
    expect(todo).not.toContain(secretoLlave);
    // Pero la invitación SÍ sale, sin su token: es parte de su equipo.
    expect(todo).toContain('invitada@test.cl');
  });

  it('dice qué dejó afuera y por qué', async () => {
    const e = await withTenant(admin, mio, (c) => exportarTenant(c, { tenantId: mio }));
    expect(Object.keys(e.fuera)).toContain('audit_log');
    expect(e.fuera.audit_log).toContain('#72');
    // Ninguna tabla puede estar dentro y fuera a la vez.
    for (const tabla of TABLAS_EXPORTADAS) {
      expect(FUERA_DE_LA_EXPORTACION[tabla], `${tabla} está en las dos listas`).toBeUndefined();
    }
  });

  it('si algo se cortó por el tope, lo dice en vez de esconderlo', async () => {
    const e = await withTenant(admin, mio, (c) => exportarTenant(c, { tenantId: mio, tope: 0 }));
    // tope 0 se sube a 1: con 1 contacto y 1 mensaje no alcanza a truncar,
    // así que se agrega uno más para forzarlo.
    expect(e.resumen.contacts).toBeLessThanOrEqual(1);
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Otra', '+56933330003', 'manual')`,
      [mio],
    );
    const e2 = await withTenant(admin, mio, (c) => exportarTenant(c, { tenantId: mio, tope: 1 }));
    expect(e2.truncadas).toContain('contacts');
    expect(e2.resumen.contacts).toBe(1);
  });
});

describe('el tope no puede llegar al SQL', () => {
  it('un tope de mentira no vacía la exportación ni toca la base', async () => {
    // Tipar el parámetro no alcanza: TypeScript no está del otro lado de un
    // HTTP, y el tope se interpola en el LIMIT.
    //
    // Lo que hacía antes no era inyectar: era peor de otra manera. `LIMIT
    // NaN` es un error de sintaxis, el catch lo tragaba y la exportación
    // salía VACÍA — el cliente se llevaba un archivo sin nada creyendo que
    // eran sus datos.
    const veneno = '1; DROP TABLE tenants; --' as unknown as number;
    const e = await withTenant(admin, mio, (c) => exportarTenant(c, { tenantId: mio, tope: veneno }));
    expect(e.resumen.contacts).toBeGreaterThan(0);
    expect(e.resumen.messages).toBeGreaterThan(0);

    const siguen = await admin.query('SELECT count(*)::int n FROM tenants WHERE id = $1', [mio]);
    expect(siguen.rows[0].n).toBe(1);
  });
});

describe('nada se queda afuera sin decirlo', () => {
  it('toda tabla del negocio se exporta o está en la lista de excluidas CON su motivo', async () => {
    // El agujero que esto tapa: agregar una tabla nueva (plantillas,
    // campañas) y olvidarse de la exportación. El negocio que se va se
    // llevaría todo MENOS lo último que construimos, y nadie se enteraría
    // hasta que alguien pidiera irse.
    const r = await admin.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
        ORDER BY table_name`,
    );
    const DE_LOS_TESTS = ['rls_demo'];
    const tablas = (r.rows as Array<{ table_name: string }>)
      .map((x) => x.table_name)
      .filter((t) => !DE_LOS_TESTS.includes(t));

    const exportadas = new Set<string>(TABLAS_EXPORTADAS);
    const huerfanas = tablas.filter(
      (t) => !exportadas.has(t) && !(t in FUERA_DE_LA_EXPORTACION),
    );
    expect(
      huerfanas,
      `Estas tablas no se exportan y tampoco dicen por qué:\n  ${huerfanas.join('\n  ')}\n` +
        'O van en TABLAS_EXPORTADAS, o en FUERA_DE_LA_EXPORTACION con su motivo.',
    ).toEqual([]);
  });
});
