import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { checkReadiness } from '../src/readiness';

/**
 * `/ready` tiene que decir POR QUÉ, no solo que no llegó (#241).
 *
 * Durante días staging respondió exactamente esto:
 *
 *   {"nombre":"postgres","ok":false,"ms":2002,"detalle":"no respondió en 2000 ms"}
 *
 * Es cierto y no sirve. El tope corta a los 2 s, el error real del pool
 * llega después, y la carrera siempre la ganaba el tope — así que la causa
 * se perdía. Hubo que buscarla desde el otro lado, mirando las conexiones
 * en Supabase.
 *
 * Distinguirlas importa: ENOTFOUND es DNS, "connection timeout" es que los
 * paquetes se pierden, ECONNREFUSED es que no hay nadie escuchando. Tres
 * problemas distintos con tres arreglos distintos.
 */
function poolQueTarda(ms: number, error?: Error): Pool {
  return {
    query: () =>
      new Promise((resolve, reject) =>
        setTimeout(() => (error ? reject(error) : resolve({ rows: [] })), ms),
      ),
  } as unknown as Pool;
}

describe('el detalle de /ready', () => {
  it('la primera sonda solo alcanza a decir que no llegó', async () => {
    const pool = poolQueTarda(4000, new Error('connect ETIMEDOUT 15.229.150.166:5432'));
    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(false);
    expect(pg.detalle).toBe('no respondió en 2000 ms');
  }, 15_000);

  it('la siguiente ya dice la causa, aunque haya llegado tarde', async () => {
    const pool = poolQueTarda(100, new Error('connect ETIMEDOUT 15.229.150.166:5432'));
    // La primera guarda el motivo al rechazar.
    await checkReadiness(pool);
    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    // Acá el error llega dentro del tope, así que se ve directo.
    expect(pg.detalle).toMatch(/ETIMEDOUT/);
  }, 15_000);

  it('un fallo lento termina apareciendo en la sonda siguiente', async () => {
    const lento = poolQueTarda(2500, new Error('getaddrinfo ENOTFOUND aws-0-sa-east-1.pooler.supabase.com'));
    // La primera se corta en el tope: el error todavía viene en camino.
    const primera = await checkReadiness(lento);
    expect(primera.dependencias[0].ok).toBe(false);
    expect(primera.dependencias[0].detalle).toMatch(/no respondió en 2000 ms/);
    expect(primera.dependencias[0].detalle).not.toMatch(/ENOTFOUND/);

    // Se le da tiempo a que el error lento aterrice.
    await new Promise((r) => setTimeout(r, 800));
    const segunda = await checkReadiness(lento);
    // Esto es lo que habría ahorrado días: la sonda dice DNS o dice red.
    expect(segunda.dependencias[0].detalle).toMatch(/ENOTFOUND/);
  }, 20_000);

  it('cuando vuelve a andar, no arrastra el motivo viejo', async () => {
    const sano = poolQueTarda(5);
    const r = await checkReadiness(sano);
    expect(r.dependencias[0].ok).toBe(true);
    expect(r.dependencias[0].detalle).toBeUndefined();
  }, 15_000);
});

describe('cuando postgres no conecta, dice a qué puerto (#241)', () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it('el puerto sale en el detalle del fallo', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    const pool = {
      query: () => new Promise(() => {}), // nunca responde: el caso real
    } as unknown as Pool;
    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(false);
    // Un timeout se ve idéntico venga del puerto que venga. Sin esto, desde
    // afuera no hay forma de saber si el contenedor tomó el valor nuevo.
    expect(pg.detalle).toContain('puerto 6543');
  });

  it('NO publica host, usuario ni contraseña', async () => {
    process.env.DATABASE_URL = 'postgres://elusuario:lacontrasena@db.interna.cl:5432/postgres';
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const r = await checkReadiness(pool);
    const detalle = JSON.stringify(r);
    // Un diagnóstico no justifica publicar a dónde nos conectamos.
    expect(detalle).not.toContain('lacontrasena');
    expect(detalle).not.toContain('elusuario');
    expect(detalle).not.toContain('db.interna.cl');
    expect(detalle).toContain('puerto 5432');
  });

  it('en verde no agrega nada: el puerto ahí es ruido', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(true);
    expect(pg.detalle ?? '').not.toContain('puerto');
  });
});
