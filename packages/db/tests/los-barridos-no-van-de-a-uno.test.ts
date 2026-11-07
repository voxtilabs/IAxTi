import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';
import { porCadaTenant } from '../src/tenant';

/**
 * Los barridos no visitan a los tenants de a uno (#1290).
 *
 * #743 arregló la otra mitad —no visitar a TODOS— y dejó esta: los de la lista
 * se visitaban en serie. Medido hoy: `maintainPartnerInvitations` tardaba más
 * de 5 s en 782 tenants y `sweepResponseSamples` ~5 s en 1.113, veinticuatro
 * veces al día. La consulta que arma la lista tarda 13–16 ms; lo que costaba
 * eran los ciclos de abrir, fijar el tenant y cerrar, pagados uno tras otro.
 *
 * Esto NO mide el reloj. Mide **cuántos están adentro a la vez**, que es lo que
 * de verdad cambió: una prueba de velocidad en una máquina cargada mide la
 * máquina, y este repo ya tiene issues de eso (#1254).
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const creados: string[] = [];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  for (let i = 0; i < 8; i++) {
    const r = await admin.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [
      `de-a-uno-${i}`,
    ]);
    creados.push(r.rows[0].id);
  }
});

afterAll(async () => {
  await admin.query('DELETE FROM tenants WHERE id = ANY($1)', [creados]);
  await admin.end();
});

/** Corre el barrido contando cuántos coinciden adentro. */
async function medirSolapamiento(concurrencia?: number) {
  let dentro = 0;
  let maximo = 0;
  const visitados = await porCadaTenant(
    admin,
    async (_c, tenantId) => {
      dentro += 1;
      maximo = Math.max(maximo, dentro);
      // Una espera corta para que haya ventana de solapamiento. No se mide
      // cuánto tarda: se mide cuántos entraron.
      await new Promise((r) => setTimeout(r, 25));
      dentro -= 1;
      return tenantId;
    },
    { ids: creados, ...(concurrencia === undefined ? {} : { concurrencia }) },
  );
  return { maximo, visitados };
}

describe('los barridos no van de a uno (#1290)', () => {
  it('visita varios a la vez', async () => {
    const { maximo } = await medirSolapamiento();
    expect(maximo, 'en serie esto daría 1, que es el defecto').toBeGreaterThan(1);
  });

  it('y no se pasa del pool: deja conexiones libres para lo demás', async () => {
    // El pool por omisión es de 6 y se reservan dos. Un barrido que se queda
    // con todas las conexiones es un barrido que tira lo demás del proceso.
    const { maximo } = await medirSolapamiento();
    expect(maximo).toBeLessThanOrEqual(4);
  });

  it('con concurrencia 1 vuelve a ser de a uno, para quien necesite orden', async () => {
    const { maximo, visitados } = await medirSolapamiento(1);
    expect(maximo).toBe(1);
    expect(visitados).toEqual(creados);
  });

  it('visita a TODOS los de la lista, y devuelve en el orden de la lista', async () => {
    // Lo que no puede pasar al paralelizar: perder trabajo o devolver
    // revuelto. El orden del VALOR se conserva aunque terminen desordenados.
    const visitados = await porCadaTenant(
      admin,
      async (_c, tenantId) => {
        // Al revés a propósito: los últimos terminan primero.
        await new Promise((r) => setTimeout(r, creados.indexOf(tenantId) % 2 === 0 ? 30 : 5));
        return tenantId;
      },
      { ids: creados },
    );
    expect(visitados).toEqual(creados);
  });

  it('un tenant que falla no deja sin barrer a los demás, y no aparece en la salida', async () => {
    // El contrato de siempre: se anota y se sigue. Con varios a la vez esto es
    // más fácil de romper, porque el fallo ocurre mientras otros corren.
    const fallados: string[] = [];
    const visitados = await porCadaTenant(
      admin,
      async (_c, tenantId) => {
        if (tenantId === creados[3]) throw new Error('este tenant explota');
        return tenantId;
      },
      { ids: creados, alFallar: (t) => fallados.push(t) },
    );
    expect(fallados).toEqual([creados[3]]);
    expect(visitados).toEqual(creados.filter((t) => t !== creados[3]));
    expect(visitados).toHaveLength(7);
  });
});
