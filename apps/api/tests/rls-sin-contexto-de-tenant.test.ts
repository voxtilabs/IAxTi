import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation } from '@iaxti/module-identity';
import { createWidget } from '@iaxti/module-webchat';
import { writeAudit } from '@iaxti/module-audit';
import { usarPool } from '../src/db';
import { WebchatController } from '../src/webchat.controller';
import { InvitacionesController } from '../src/equipo-usuarios.controller';
import { PlatformAuditController } from '../src/audit.controller';
import type { WithUser } from '../src/authz/authz.guard';

/**
 * Tres rutas que corrían SIN `app.tenant_id` sobre tablas con RLS FORCE.
 *
 * Con el rol de desarrollo —`iaxti`, superusuario— Postgres ni mira las
 * políticas, así que las tres funcionan y la suite entera está verde. Con un
 * rol que respete RLS, que es a dónde va el producto (#370) y lo que el
 * runbook exige en producción, la política evalúa `tenant_id = NULL` y
 * devuelve CERO filas. Sin error: cero filas se parece a "no hay nada".
 *
 * Por eso este archivo se conecta con un rol propio, sin superusuario ni
 * BYPASSRLS, como el de producción. Es la única forma de que la prueba vea
 * el defecto: con `iaxti` pasaría igual de roto.
 *
 * El rol NO se llama `iaxti_app` a propósito: ese nombre lo usa
 * `packages/db/tests/barridos-con-el-rol-real.test.ts` y los dos archivos
 * pueden correr a la vez. Dos `CREATE ROLE` simultáneos sobre el mismo
 * nombre es una carrera que falla sin tener nada que ver con lo que se mide.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ROL = 'iaxti_rls_ctx';

let admin: Pool;
let app: Pool;
let tenant: string;
let widgetId: string;
let tokenInvitacion: string;
let entradasDelLibro: number;
const invitado = randomUUID();

const DOMINIO = 'sitio-rls.cl';

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);

  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL}') THEN
        CREATE ROLE ${ROL} LOGIN PASSWORD '${ROL}';
      END IF;
    END $$
  `);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROL}`);
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROL}`,
  );
  await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ROL}`);
  // Las funciones SECURITY DEFINER que resuelven "de quién es esto" NO están
  // abiertas a PUBLIC: el EXECUTE se concede a mano, igual que en producción.
  for (const fn of ['tenant_de_widget_de_webchat(uuid)', 'tenant_de_invitacion(text)']) {
    await admin
      .query(`GRANT EXECUTE ON FUNCTION ${fn} TO ${ROL}`)
      // Si la función todavía no existe (el arreglo no está aplicado), el
      // GRANT falla y da igual: lo que se mide es la ruta, no el GRANT.
      .catch(() => undefined);
  }
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, `//${ROL}:${ROL}@`));

  const t = await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('rls-sin-contexto', 'base', 'active') RETURNING id",
  );
  tenant = t.rows[0].id;

  const widget = await withTenant(admin, tenant, (c) =>
    createWidget(c, { tenantId: tenant, allowedDomain: DOMINIO, name: 'Chat del sitio' }),
  );
  widgetId = widget.id;

  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'nueva@sitio-rls.cl', roleName: 'USER' }),
  );
  tokenInvitacion = inv.token;

  await withTenant(admin, tenant, (c) =>
    writeAudit(c, {
      tenantId: tenant,
      actor: randomUUID(),
      actorKind: 'user',
      action: 'prueba.rls',
      resource: 'demo',
      resourceId: 'x-1',
      result: 'ok',
      ip: '190.44.1.2',
    }),
  );
  const n = await admin.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [
    tenant,
  ]);
  entradasDelLibro = n.rows[0].n;

  // La API habla por el pool del rol de aplicación, no por el de desarrollo.
  usarPool(app);
});

afterAll(async () => {
  usarPool(null);
  await app.end();
  await admin.end();
});

describe('el widget de webchat se lee con el tenant de su dueño', () => {
  it('responde la configuración con un rol que respeta RLS', async () => {
    // Sin el arreglo: `findWidgetById` corre con una conexión suelta, la
    // política de `webchat_widgets` devuelve cero filas y el widget entero
    // "no existe" — o sea que el chat del sitio de cualquier cliente deja de
    // cargar el día que la aplicación se conecte con el rol correcto.
    const r = await new WebchatController().config(widgetId, `https://${DOMINIO}/contacto`);
    expect(r).toEqual({ name: 'Chat del sitio', welcomeMessage: expect.any(String) });
  });

  it('un widget que no existe sigue siendo un 404 mudo', async () => {
    await expect(
      new WebchatController().config(randomUUID(), `https://${DOMINIO}/contacto`),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('fuera del dominio autorizado sigue siendo un 404 mudo', async () => {
    await expect(
      new WebchatController().config(widgetId, 'https://otro-sitio.cl/contacto'),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });
});

describe('aceptar una invitación', () => {
  it('canjea el token con un rol que respeta RLS', async () => {
    // Sin el arreglo: el SELECT de la invitación devuelve cero filas y la
    // respuesta es "Esa invitación no existe. Pide que te inviten de nuevo."
    // en el primer momento de un empleado en el producto. Y si la lectura
    // pasara, el INSERT en `user_roles` chocaría con su WITH CHECK.
    const request = { user: { userId: invitado }, requestId: 'req_rls_ctx' } as unknown as WithUser;
    const r = await new InvitacionesController().aceptar(request, tokenInvitacion);
    expect(r).toEqual({ tenantId: tenant, roleName: 'USER' });

    const rol = await withTenant(admin, tenant, async (c) => {
      const q = await c.query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
        [tenant, invitado],
      );
      return q.rows[0]?.name as string | undefined;
    });
    expect(rol).toBe('USER');
  });

  it('un token inventado sigue respondiendo INVITATION_INVALID', async () => {
    const request = { user: { userId: randomUUID() } } as unknown as WithUser;
    await expect(
      new InvitacionesController().aceptar(request, 'este-token-no-existe'),
    ).rejects.toMatchObject({ response: { code: 'INVITATION_INVALID' } });
  });
});

describe('la verificación de la cadena del libro de auditoría', () => {
  it('cuenta las entradas que el libro tiene de verdad', async () => {
    // Éste es el peor de los tres: sin el arreglo devuelve
    // `{ valid: true, entries: 0 }`. Un libro append-only cuya verificación
    // dice "válido" sin haber podido leer una sola fila da una garantía que
    // no comprobó, y es justo lo que un auditor viene a mirar.
    const r = await new PlatformAuditController().verify(tenant, {});
    expect(r).toEqual({ valid: true, entries: entradasDelLibro });
    expect(entradasDelLibro).toBeGreaterThan(0);
  });

  it('verificar el libro de un negocio que no existe no es "válido"', async () => {
    await expect(new PlatformAuditController().verify(randomUUID(), {})).rejects.toMatchObject({
      response: { code: 'TENANT_NOT_FOUND' },
    });
  });

  it('sin tenant sigue pidiendo cuál', async () => {
    await expect(new PlatformAuditController().verify('', {})).rejects.toMatchObject({
      response: { code: 'TENANT_REQUIRED' },
    });
  });
});
