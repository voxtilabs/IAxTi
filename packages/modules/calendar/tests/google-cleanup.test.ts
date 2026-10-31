import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSecretStore } from '@iaxti/google';
import { Pool } from 'pg';
import { runMigrations, withTenant } from '@iaxti/db';
import { verifyChain, writeAudit } from '@iaxti/module-audit';
import { bloquearGrantGoogle, limpiarVersionesGoogle, type GoogleAudit } from '@iaxti/module-identity';
import { limpiarSecretosGoogle } from '../application/google';
import type { CalendarGoogleDeps } from '../application/google-config';

const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const role = `google_cleanup_${randomBytes(6).toString('hex')}`;
const database = `iaxti_google_cleanup_${randomBytes(6).toString('hex')}`;
let control: Pool; let admin: Pool; let app: Pool; let tenantId: string; let other: string;
let roleCreated = false;
let deps: CalendarGoogleDeps;
const audit: GoogleAudit = async (client, entry) => writeAudit(client, {
  ...entry, resource: 'google_integration', actorKind: 'system',
});

beforeAll(async () => {
  // El compositor barre TODOS los pendientes. Una base propia impide que
  // proveedores simulados distintos destruyan fixtures de otros archivos.
  // Mismo permiso CREATE DATABASE que migraciones-en-base-virgen.mjs en CI.
  control = new Pool({ connectionString: url });
  await control.query(`CREATE DATABASE ${database}`);
  const isolatedUrl = new URL(url);
  isolatedUrl.pathname = `/${database}`;
  admin = new Pool({ connectionString: isolatedUrl.href });
  await runMigrations(admin);
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS NOSUPERUSER`);
  roleCreated = true;
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  app = new Pool({ connectionString: isolatedUrl.href, options: `-c role=${role}`, max: 4 });
});
afterAll(async () => {
  try {
    await app?.end();
    if (admin) {
      try {
        if (roleCreated) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      } finally { await admin.end(); }
    }
  } finally {
    if (control) {
      // pg-pool resuelve end() al retirar sus clientes, antes de que todos sus
      // sockets terminen de cerrar. FORCE podía interrumpir ese cierre con un
      // 57P01 no manejado. DROP normal espera la desconexión y denuncia una fuga.
      try { await control.query(`DROP DATABASE IF EXISTS ${database}`); }
      finally { await control.end(); }
    }
  }
});
beforeEach(async () => {
  tenantId = (await admin.query("INSERT INTO tenants(name) VALUES('google-cleanup') RETURNING id")).rows[0].id;
  other = (await admin.query("INSERT INTO tenants(name) VALUES('google-cleanup-other') RETURNING id")).rows[0].id;
  const unexpected = async (): Promise<never> => { throw new Error('Este barrido no debe acceder a datos de Google.'); };
  deps = {
    clientId: 'test-client', webhookAddress: 'https://example.test/webhooks/google/calendar',
    oauth: { authorizationUrl: () => '', exchange: unexpected, verifyIdToken: unexpected, refresh: unexpected, revoke: unexpected },
    calendar: { freebusy: unexpected, watch: unexpected, stop: unexpected },
    secrets: { put: unexpected, addVersion: unexpected, access: unexpected,
      destroy: vi.fn(async () => {}), deleteSecret: vi.fn(async () => {}) },
  };
});
afterEach(async () => {
  if (!tenantId || !other) return;
  // Los fallos persistentes de un caso no contaminan los barridos del siguiente.
  await admin.query('DELETE FROM google_secret_versions WHERE tenant_id=ANY($1)', [[tenantId, other]]);
  await admin.query('DELETE FROM google_oauth_grants WHERE tenant_id=ANY($1)', [[tenantId, other]]);
  await admin.query('DELETE FROM google_oauth_attempts WHERE tenant_id=ANY($1)', [[tenantId, other]]);
});

async function pending(input: { whole?: boolean; tenant?: string; age?: string; user?: string } = {}) {
  const id = `iaxti-google-${randomUUID()}`;
  const ref = input.whole ? id : `projects/iaxti-test/secrets/${id}/versions/1`;
  const user = input.user ?? randomUUID();
  await admin.query(`INSERT INTO google_secret_versions(tenant_id,user_id,secret_ref,destroy_pending,whole_secret,created_at)
    VALUES($1,$2,$3,true,$4,now()-$5::interval)`,
  [input.tenant ?? tenantId, user, ref, input.whole ?? false, input.age ?? '2 days']);
  return { ref, user, id };
}
const sweep = () => withTenant(app, tenantId, client => limpiarVersionesGoogle(client, {
  tenantId, destroy: deps.secrets.destroy, deleteSecret: deps.secrets.deleteSecret, audit,
}));

describe('limpieza durable de secretos de Google', () => {
  it('registra cada fallo, conserva su pendiente y procesa las otras filas y negocios con RLS real', async () => {
    expect((await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
      .toEqual({ rolsuper: false, rolbypassrls: false });
    const denied = await pending({ whole: true });
    const timeout = await pending();
    const healthy = await pending();
    const elsewhere = await pending({ tenant: other });
    vi.mocked(deps.secrets.deleteSecret).mockRejectedValue(new Error('403 token privado que nunca debe registrarse'));
    vi.mocked(deps.secrets.destroy).mockImplementation(async ref => {
      if (ref === timeout.ref) throw new Error('timeout con token privado');
    });
    expect(await limpiarSecretosGoogle(app, deps)).toEqual({ destroyed: 2, failed: 2 });
    expect(deps.secrets.destroy).toHaveBeenCalledWith(healthy.ref);
    expect(deps.secrets.destroy).toHaveBeenCalledWith(elsewhere.ref);
    const remaining = await withTenant(app, tenantId, client => client.query(
      'SELECT secret_ref,destroy_pending,created_at>now()-interval \'1 minute\' AS rotated FROM google_secret_versions'));
    expect(remaining.rows.map(r => r.secret_ref).sort()).toEqual([denied.ref, timeout.ref].sort());
    expect(remaining.rows.every(r => r.destroy_pending && r.rotated)).toBe(true);
    const entries = await admin.query("SELECT action,result,metadata FROM audit_log WHERE tenant_id=$1 AND action='google.secret.destroyed'", [tenantId]);
    expect(entries.rows.filter(r => r.result === 'error')).toHaveLength(2);
    expect(entries.rows.filter(r => r.result === 'ok')).toHaveLength(1);
    expect(JSON.stringify(entries.rows)).not.toContain('token privado');
    expect((await withTenant(app, tenantId, client => verifyChain(client, tenantId))).valid).toBe(true);
  });

  it('recupera un error SQL mediante SAVEPOINT y conserva su auditoría de error', async () => {
    const broken = await pending();
    const healthy = await pending();
    const trigger = `cleanup_fail_${randomBytes(5).toString('hex')}`;
    await admin.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.secret_ref='${broken.ref}' THEN RAISE EXCEPTION 'fallo SQL de prueba'; END IF; RETURN OLD; END $$`);
    await admin.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON google_secret_versions FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      expect(await sweep()).toEqual({ destroyed: 1, failed: 1 });
      expect((await admin.query('SELECT secret_ref FROM google_secret_versions WHERE tenant_id=$1', [tenantId])).rows)
        .toEqual([{ secret_ref: broken.ref }]);
      expect(deps.secrets.destroy).toHaveBeenCalledWith(healthy.ref);
      expect((await admin.query("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='google.secret.destroyed' AND result='error'", [tenantId])).rowCount).toBe(1);
    } finally {
      await admin.query(`DROP TRIGGER ${trigger} ON google_secret_versions`);
      await admin.query(`DROP FUNCTION ${trigger}()`);
    }
    // La llamada externa anterior pudo completarse: repetirla debe ser idempotente.
    expect(await sweep()).toEqual({ destroyed: 1, failed: 0 });
  });

  it('rota cien secretos que siempre fallan y alcanza la versión 101 en el siguiente barrido', async () => {
    for (let i = 0; i < 100; i++) await pending({ whole: true });
    const healthy = await pending({ age: '1 day' });
    vi.mocked(deps.secrets.deleteSecret).mockRejectedValue(new Error('403 persistente'));
    expect(await sweep()).toEqual({ destroyed: 0, failed: 100 });
    expect(deps.secrets.destroy).not.toHaveBeenCalled();
    expect(await sweep()).toEqual({ destroyed: 1, failed: 0 });
    expect(deps.secrets.destroy).toHaveBeenCalledExactlyOnceWith(healthy.ref);
    expect(deps.secrets.deleteSecret).toHaveBeenCalledTimes(100);
    expect((await admin.query('SELECT 1 FROM google_secret_versions WHERE tenant_id=$1', [tenantId])).rowCount).toBe(100);
  });

  it('omite la versión activa, su secreto completo, una intención reciente y filas bloqueadas', async () => {
    const active = await pending();
    await admin.query(`INSERT INTO google_oauth_grants(id,tenant_id,user_id,client_id,google_subject,secret_ref,scopes,status)
      VALUES($1,$2,$3,'client','subject',$4,'{}','active')`, [randomUUID(), tenantId, active.user, active.ref]);
    await admin.query(`INSERT INTO google_secret_versions(tenant_id,user_id,secret_ref,destroy_pending,whole_secret,created_at)
      VALUES($1,$2,$3,true,true,now()-interval '2 days')`, [tenantId, active.user, active.id]);
    await pending({ whole: true, age: '1 minute' });
    const locked = await pending({ whole: true });
    const healthy = await pending();
    const blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM google_secret_versions WHERE secret_ref=$1 FOR UPDATE', [locked.ref]);
    try {
      expect(await sweep()).toEqual({ destroyed: 1, failed: 0 });
      expect(deps.secrets.destroy).toHaveBeenCalledExactlyOnceWith(healthy.ref);
      expect(deps.secrets.deleteSecret).not.toHaveBeenCalled();
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await sweep()).toEqual({ destroyed: 1, failed: 0 });
    expect(deps.secrets.deleteSecret).toHaveBeenCalledExactlyOnceWith(locked.ref);
  });

it('con la custodia en el VPS la recolección sigue encontrando el secreto completo', async () => {
  /*
   * La prueba que justifica el desvío de ADR-0027.
   *
   * La recolección decide si un secreto completo sigue en uso con
   *
   *     g.secret_ref LIKE '%/secrets/' || v.secret_ref || '/versions/%'
   *
   * o sea comparando la FORMA de la referencia. Secret Manager devuelve
   * `projects/<p>/secrets/<id>/versions/<n>`; la custodia local devuelve
   * `custodia-local/secrets/<id>/versions/<n>`. Si esa forma no se hubiera
   * respetado, el `LIKE` dejaría de calzar y el barrido se llevaría por
   * delante el secreto de un grant VIVO —o, en el otro sentido, nunca
   * recogería los reemplazados—, las dos cosas sin fallar y sin avisar.
   *
   * Por eso acá no se simula el almacén: se usa el de verdad, contra disco.
   */
  const directorio = await mkdtemp(join(tmpdir(), 'iaxti-custodia-'));
  try {
    const local = createLocalSecretStore({ directorio, clave: randomBytes(32).toString('base64') });
    const barrer = () => withTenant(app, tenantId, (client) => limpiarVersionesGoogle(client, {
      tenantId, destroy: (ref) => local.destroy(ref), deleteSecret: (id) => local.deleteSecret(id), audit,
    }));

    const user = randomUUID();
    const secretoId = `iaxti-google-${randomUUID()}`;
    const ref = await local.put(secretoId, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
    expect(ref).toBe(`custodia-local/secrets/${secretoId}/versions/1`);

    // Un grant VIVO apuntando a esa versión, y la intención del secreto
    // completo ya vieja: el barrido tiene que dejarlos en paz.
    await admin.query(`INSERT INTO google_oauth_grants(id,tenant_id,user_id,client_id,google_subject,secret_ref,scopes,status)
      VALUES($1,$2,$3,'client','subject',$4,'{}','active')`, [randomUUID(), tenantId, user, ref]);
    await admin.query(`INSERT INTO google_secret_versions(tenant_id,user_id,secret_ref,destroy_pending,whole_secret,created_at)
      VALUES($1,$2,$3,true,true,now()-interval '2 days')`, [tenantId, user, secretoId]);

    expect(await barrer()).toEqual({ destroyed: 0, failed: 0 });
    expect(await local.access(ref)).toContain('refreshToken');

    // Revocado el grant, el mismo barrido sí se lo lleva, y el disco queda
    // limpio: la custodia local honra `deleteSecret` de verdad.
    await admin.query("UPDATE google_oauth_grants SET status='revoked' WHERE tenant_id=$1", [tenantId]);
    expect(await barrer()).toEqual({ destroyed: 1, failed: 0 });
    await expect(readdir(join(directorio, secretoId))).rejects.toThrow();
  } finally {
    await rm(directorio, { recursive: true, force: true });
  }
});

  it('continúa con el otro tenant si la transacción de uno no puede iniciar la limpieza', async () => {
    const healthy = await pending({ tenant: other });
    await admin.query(`INSERT INTO google_oauth_attempts(id,tenant_id,user_id,state_hash,challenge,nonce_hash,service,expires_at)
      VALUES($1,$2,$3,$4,'challenge','nonce','calendar',now()-interval '1 day')`, [randomUUID(), tenantId, randomUUID(), randomUUID()]);
    const trigger = `cleanup_tenant_${randomBytes(5).toString('hex')}`;
    await admin.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.tenant_id='${tenantId}'::uuid THEN RAISE EXCEPTION 'tenant indisponible'; END IF; RETURN OLD; END $$`);
    await admin.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON google_oauth_attempts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      expect(await limpiarSecretosGoogle(app, deps)).toEqual({ destroyed: 1, failed: 1 });
      expect(deps.secrets.destroy).toHaveBeenCalledExactlyOnceWith(healthy.ref);
    } finally {
      await admin.query(`DROP TRIGGER ${trigger} ON google_oauth_attempts`);
      await admin.query(`DROP FUNCTION ${trigger}()`);
    }
  });

  it('el compositor no abre una transacción de limpieza para un negocio sin pendientes', async () => {
    const healthy = await pending();
    const trigger = `cleanup_empty_${randomBytes(5).toString('hex')}`;
    await admin.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('app.tenant_id',true)='${other}' THEN RAISE EXCEPTION 'no visitar negocio vacío'; END IF; RETURN NULL; END $$`);
    await admin.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON google_oauth_attempts FOR EACH STATEMENT EXECUTE FUNCTION ${trigger}()`);
    try {
      expect(await limpiarSecretosGoogle(app, deps)).toEqual({ destroyed: 1, failed: 0 });
      expect(deps.secrets.destroy).toHaveBeenCalledExactlyOnceWith(healthy.ref);
    } finally {
      await admin.query(`DROP TRIGGER ${trigger} ON google_oauth_attempts`);
      await admin.query(`DROP FUNCTION ${trigger}()`);
    }
  });

  it('falla sin esperar la cuenta cuando el llamador ya tiene una transacción con auditoría', async () => {
    const active = await pending();
    const subject = randomUUID();
    await admin.query(`INSERT INTO google_oauth_grants(id,tenant_id,user_id,client_id,google_subject,secret_ref,scopes,status)
      VALUES($1,$2,$3,'client',$4,$5,'{}','active')`, [randomUUID(), tenantId, active.user, subject, active.ref]);
    const blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`google:client:${subject}`]);
    try {
      await withTenant(app, tenantId, async client => {
        await writeAudit(client, { tenantId, actor: 'system', actorKind: 'system', action: 'test.before', resource: 'google_integration', result: 'ok' });
        await client.query("SET LOCAL statement_timeout='250ms'");
        await expect(bloquearGrantGoogle(client, { tenantId, userId: active.user, noEsperar: true })).rejects.toThrow('se está actualizando');
        expect((await client.query('SELECT 1 AS healthy')).rows[0].healthy).toBe(1);
      });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await withTenant(app, tenantId, client => bloquearGrantGoogle(client, { tenantId, userId: active.user })))
      .toMatchObject({ userId: active.user, status: 'active' });
  });
});
