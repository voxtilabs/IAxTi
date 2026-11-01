import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  borrarHilo,
  guardarHilo,
  leerHilo,
  listarHilos,
  purgarHilosViejos,
  tituloDesdeElPrimerTurno,
} from '../application/hilos-del-agente';

/**
 * El hilo con el Agente General se guarda, y es de QUIEN lo habló (#1131).
 *
 * Lo que esto protege no es la comodidad de no perder la charla: el agente
 * PROPONE acciones que el humano aprueba, y una propuesta sin resolver que
 * desaparece deja al dueño sin saber qué le habían ofrecido.
 */
/** Igual que el resto de las pruebas del módulo: sin variable, el local. */
const URL_BASE = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let pool: Pool;
let tenantA: string;
let tenantB: string;
const persona = randomUUID();
const otraPersona = randomUUID();

const turno = (role: 'user' | 'assistant', content: string) => ({ role, content });

beforeAll(async () => {
  pool = createPool(URL_BASE);
  await runMigrations(pool);
  const crear = async (nombre: string) =>
    (await pool.query("INSERT INTO tenants (name, plan, state) VALUES ($1, 'base', 'active') RETURNING id", [nombre]))
      .rows[0].id as string;
  tenantA = await crear(`hilos-a-${randomUUID().slice(0, 8)}`);
  tenantB = await crear(`hilos-b-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) await pool.query('DELETE FROM tenants WHERE id = $1', [t]);
  await pool.end();
});

describe('el hilo con el Agente General', () => {
  it('se guarda entero y vuelve igual, con sus pasos y propuestas', async () => {
    const turnos = [
      turno('user', 'Armá un embudo de ventas'),
      { ...turno('assistant', 'Listo.'), pasos: [{ herramienta: 'crm.pipelines.create', ok: true }],
        propuesta: { herramienta: 'crm.pipelines.create', argumentos: { nombre: 'Ventas' } }, resuelta: 'aplicada' },
    ];
    const { id } = await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: persona, turnos }));
    const leido = await withTenant(pool, tenantA, (c) => leerHilo(c, { tenantId: tenantA, userId: persona, id }));
    // El hilo COMPLETO, no solo el texto: el estado de una propuesta vive en
    // un turno anterior y es justo lo que no se puede perder.
    expect(leido?.turnosCompletos).toEqual(turnos);
    expect(leido?.titulo).toBe('Armá un embudo de ventas');
  });

  it('reemplaza el hilo entero, no agrega el último turno', async () => {
    // Lo que cambia no es solo el final: una propuesta pendiente pasa a
    // aplicada, y eso está arriba. Guardar «el último» dejaría el estado de
    // las propuestas congelado en lo que era al escribirlas.
    const { id } = await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: persona, turnos: [
        turno('user', 'Creá una etiqueta'),
        { ...turno('assistant', 'Te propongo esto.'), propuesta: { herramienta: 'crm.tags.create' } },
      ] }));
    await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: persona, id, turnos: [
        turno('user', 'Creá una etiqueta'),
        { ...turno('assistant', 'Te propongo esto.'), propuesta: { herramienta: 'crm.tags.create' }, resuelta: 'aplicada' },
        turno('user', 'Gracias'),
      ] }));
    const leido = await withTenant(pool, tenantA, (c) => leerHilo(c, { tenantId: tenantA, userId: persona, id }));
    expect(leido?.turnosCompletos).toHaveLength(3);
    expect((leido?.turnosCompletos[1] as { resuelta?: string }).resuelta).toBe('aplicada');
  });

  it('es PERSONAL: lo que yo hablé no aparece en la lista de otra persona', async () => {
    await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: otraPersona, turnos: [turno('user', 'Lo mío')] }));
    const mios = await withTenant(pool, tenantA, (c) => listarHilos(c, { tenantId: tenantA, userId: persona }));
    expect(mios.every((h) => h.titulo !== 'Lo mío')).toBe(true);
    const suyos = await withTenant(pool, tenantA, (c) => listarHilos(c, { tenantId: tenantA, userId: otraPersona }));
    expect(suyos.map((h) => h.titulo)).toContain('Lo mío');
  });

  it('un hilo de otro negocio no se lee ni con el id en la mano', async () => {
    const { id } = await withTenant(pool, tenantB, (c) =>
      guardarHilo(c, { tenantId: tenantB, userId: persona, turnos: [turno('user', 'Secreto del negocio B')] }));
    const robado = await withTenant(pool, tenantA, (c) =>
      leerHilo(c, { tenantId: tenantA, userId: persona, id }));
    expect(robado).toBeNull();
  });

  it('el rol SIN BYPASSRLS tampoco lo ve: la política es la que aísla', async () => {
    // El rol de las pruebas suele ser superusuario y entonces RLS no se
    // evalúa: un `WHERE tenant_id` propio haría pasar esto con la política
    // apagada. Con un rol que SÍ la evalúa, lo que responde es la política.
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_hilos_test') THEN
        CREATE ROLE iaxti_hilos_test LOGIN PASSWORD 'iaxti_hilos_test' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`);
    await pool.query('GRANT USAGE ON SCHEMA public TO iaxti_hilos_test');
    await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON agent_general_threads TO iaxti_hilos_test');
    const app = createPool(URL_BASE.replace(/\/\/[^@]+@/, '//iaxti_hilos_test:iaxti_hilos_test@'));
    try {
      expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
        .toEqual({ rolsuper: false, rolbypassrls: false });
      const { id } = await withTenant(app, tenantB, (c) =>
        guardarHilo(c, { tenantId: tenantB, userId: persona, turnos: [turno('user', 'Del B, con RLS de verdad')] }));
      // Desde A, con el id correcto y el rol que evalúa la política: nada.
      const crudo = await withTenant(app, tenantA, (c) =>
        c.query('SELECT id FROM agent_general_threads WHERE id = $1', [id]));
      expect(crudo.rowCount).toBe(0);
    } finally {
      await app.end();
    }
  });

  it('borrar saca el hilo, y borrar el de otro no hace nada', async () => {
    const { id } = await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: persona, turnos: [turno('user', 'Para borrar')] }));
    expect(await withTenant(pool, tenantA, (c) => borrarHilo(c, { tenantId: tenantA, userId: otraPersona, id })))
      .toBe(false);
    expect(await withTenant(pool, tenantA, (c) => borrarHilo(c, { tenantId: tenantA, userId: persona, id })))
      .toBe(true);
    expect(await withTenant(pool, tenantA, (c) => leerHilo(c, { tenantId: tenantA, userId: persona, id }))).toBeNull();
  });

  it('guardar con un id que ya no existe crea uno nuevo, no pierde la charla', async () => {
    // Pasa de verdad: el barrido purga a los 30 días con la pestaña abierta.
    const fantasma = randomUUID();
    const { id } = await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: persona, id: fantasma, turnos: [turno('user', 'Sobrevivió')] }));
    expect(id).not.toBe(fantasma);
    const leido = await withTenant(pool, tenantA, (c) => leerHilo(c, { tenantId: tenantA, userId: persona, id }));
    expect(leido?.titulo).toBe('Sobrevivió');
  });

  it('el barrido borra lo viejo y respeta lo reciente', async () => {
    const { id: viejo } = await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: persona, turnos: [turno('user', 'Viejo')] }));
    const { id: nuevo } = await withTenant(pool, tenantA, (c) =>
      guardarHilo(c, { tenantId: tenantA, userId: persona, turnos: [turno('user', 'Nuevo')] }));
    await pool.query("UPDATE agent_general_threads SET updated_at = now() - interval '45 days' WHERE id = $1", [viejo]);
    // El barrido corre sin tenant fijado, así que va con un cliente suelto —
    // y se devuelve: una prueba que se queda una conexión agota el pool de
    // las que vienen después.
    const cliente = await pool.connect();
    let borrados = 0;
    try {
      borrados = await purgarHilosViejos(cliente);
    } finally {
      cliente.release();
    }
    expect(borrados).toBeGreaterThanOrEqual(1);
    expect(await withTenant(pool, tenantA, (c) => leerHilo(c, { tenantId: tenantA, userId: persona, id: viejo }))).toBeNull();
    expect(await withTenant(pool, tenantA, (c) => leerHilo(c, { tenantId: tenantA, userId: persona, id: nuevo }))).not.toBeNull();
  });

  it('el título sale de lo primero que escribió la persona, no del modelo', () => {
    expect(tituloDesdeElPrimerTurno([turno('assistant', 'Hola'), turno('user', '  Armá   mis embudos ')]))
      .toBe('Armá mis embudos');
    expect(tituloDesdeElPrimerTurno([turno('user', 'x'.repeat(200))]).length).toBe(80);
    expect(tituloDesdeElPrimerTurno([])).toBe('Sin título');
  });
});
