import { describe, expect, it } from 'vitest';
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
