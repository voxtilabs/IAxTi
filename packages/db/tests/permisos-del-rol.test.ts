import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';
import { comoSeLee, permisosDelRol } from '../src/permisos-del-rol';

/**
 * Antes de cambiarle el rol a la aplicación, saber qué le falta (#370).
 *
 * El riesgo real de esta corrección no es el aislamiento: es que el rol
 * nuevo respete RLS y NO pueda escribir en alguna tabla que el camino de
 * entrada toca. Eso se ve como `permission denied` en medio de un mensaje
 * de un cliente, en vivo, y la lista de tablas que hay que conceder no la
 * sabe nadie de memoria — el camino de entrada toca siete.
 *
 * Por eso la comprobación pregunta al catálogo en vez de llevar una lista.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ROL = 'iaxti_permisos_test';

let admin: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL}') THEN
        CREATE ROLE ${ROL} LOGIN PASSWORD '${ROL}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$
  `);
});

afterAll(async () => {
  await admin.query(`REASSIGN OWNED BY ${ROL} TO CURRENT_USER`).catch(() => undefined);
  await admin.query(`DROP OWNED BY ${ROL}`).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch(() => undefined);
  await admin.end();
});

describe('los permisos del rol de la aplicación (#370)', () => {
  it('un rol recién creado NO está listo, y dice exactamente qué le falta', async () => {
    // Recién creado no puede tocar ninguna tabla. Lo que importa no es que
    // diga "no", es que diga QUÉ.
    //
    // Ojo con el esquema: `USAGE` en `public` viene concedido a PUBLIC por
    // defecto, así que esa comprobación casi nunca se enciende —se deja
    // porque una base endurecida sí se lo quita, y entonces no arranca
    // nada y el motivo no se parece en nada a la causa.
    const d = await permisosDelRol(admin, ROL);
    expect(d.listo).toBe(false);
    expect(d.seSalta).toBe(false);
    expect(d.faltan.some((f) => f.objeto === 'tabla contacts' && f.privilegio === 'INSERT')).toBe(true);
    expect(d.faltan.some((f) => f.objeto === 'tabla messages' && f.privilegio === 'SELECT')).toBe(true);
    for (const f of d.faltan) expect(f.consecuencia.length).toBeGreaterThan(20);
  });

  it('con los permisos del runbook queda listo', async () => {
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROL}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROL}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROL}`);
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROL}`);
    await admin.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${ROL}`);
    await admin.query(`REVOKE UPDATE, DELETE ON platform_audit FROM ${ROL}`);
    await admin.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${ROL}`);

    const d = await permisosDelRol(admin, ROL);
    expect(comoSeLee(d)).toContain('LISTO');
    expect(d.faltan).toEqual([]);
    expect(d.sobran).toEqual([]);
  });

  it('el libro de auditoría con permiso de borrar es un permiso QUE SOBRA', async () => {
    // No impide desplegar —el trigger igual lo rechaza— pero se informa:
    // un permiso que nadie usa es uno que alguien puede usar.
    await admin.query(`GRANT DELETE ON audit_log TO ${ROL}`);
    const d = await permisosDelRol(admin, ROL);
    expect(d.sobran.some((s) => s.objeto === 'tabla audit_log' && s.privilegio === 'DELETE')).toBe(true);
    expect(d.listo).toBe(true); // sobrar no bloquea; faltar sí
    await admin.query(`REVOKE DELETE ON audit_log FROM ${ROL}`);
  });

  it('una tabla nueva sin conceder aparece sola, sin tocar ninguna lista', async () => {
    // Es la razón de preguntarle al catálogo: la próxima migración trae una
    // tabla que nadie va a acordarse de agregar acá.
    await admin.query('CREATE TABLE IF NOT EXISTS tabla_recien_migrada (id int)');
    try {
      const d = await permisosDelRol(admin, ROL);
      expect(d.faltan.some((f) => f.objeto === 'tabla tabla_recien_migrada')).toBe(true);
      expect(d.listo).toBe(false);
    } finally {
      await admin.query('DROP TABLE IF EXISTS tabla_recien_migrada');
    }
  });

  it('un rol que se salta RLS no está listo aunque tenga todos los permisos', async () => {
    // El caso de staging: `postgres` de Supabase puede todo y por eso mismo
    // no sirve. Se informa PRIMERO, porque los permisos de abajo dan igual.
    const d = await permisosDelRol(admin, 'postgres').catch(() => null);
    if (!d) return; // no hay rol `postgres` en esta base: nada que probar
    if (!d.seSalta) return;
    expect(d.listo).toBe(false);
    expect(d.faltan[0].privilegio).toContain('NOBYPASSRLS');
  });

  it('un rol que no existe se dice como tal, no como "le faltan 300 permisos"', async () => {
    const d = await permisosDelRol(admin, 'rol_que_no_existe_jamas');
    expect(d.faltan).toHaveLength(1);
    expect(d.faltan[0].privilegio).toBe('EXISTIR');
  });
});
