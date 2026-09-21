import { describe, expect, it, vi } from 'vitest';
import { conReintentoDeConexion, esFalloDeConexion } from '../src/lib/arranque-en-frio';

/**
 * Reintentar solo lo que tiene sentido reintentar (#361).
 *
 * La distinción es toda la utilidad de esto: una conexión que no entró,
 * reintentada, entra. Una consulta mal escrita reintentada es la misma
 * consulta mal escrita, y el reintento esconde el error de verdad.
 */
describe('qué cuenta como "no pude llegar a la base"', () => {
  it('reconoce lo que dice pg cuando el pooler todavía no despierta', () => {
    expect(esFalloDeConexion(new Error('Connection terminated due to connection timeout'))).toBe(true);
    expect(esFalloDeConexion(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(esFalloDeConexion(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(esFalloDeConexion(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('NO reconoce un error de la consulta, aunque suene feo', () => {
    // 42P01 = tabla que no existe. Reintentarlo es perder tiempo y esconder
    // el problema: la tabla va a seguir sin existir.
    expect(esFalloDeConexion(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }))).toBe(false);
    expect(esFalloDeConexion(Object.assign(new Error('permiso denegado'), { code: '42501' }))).toBe(false);
    expect(esFalloDeConexion(new Error('La firma del webhook no calza.'))).toBe(false);
    expect(esFalloDeConexion(null)).toBe(false);
  });
});

describe('el reintento', () => {
  it('la segunda entra: el mensaje no se pierde por un arranque en frío', async () => {
    let intentos = 0;
    const r = await conReintentoDeConexion(
      async () => {
        intentos++;
        if (intentos === 1) throw new Error('Connection terminated due to connection timeout');
        return 'guardado';
      },
      { esperaMs: 1 },
    );
    expect(r).toBe('guardado');
    expect(intentos).toBe(2);
  });

  it('un error de consulta NO se reintenta', async () => {
    let intentos = 0;
    await expect(
      conReintentoDeConexion(async () => {
        intentos++;
        throw Object.assign(new Error('relation no existe'), { code: '42P01' });
      }),
    ).rejects.toThrow('relation no existe');
    expect(intentos).toBe(1);
  });

  it('reintenta UNA vez, no en bucle', async () => {
    // El proveedor tiene su propio timeout. Si la segunda tampoco entra, la
    // base está caída de verdad y alargar la respuesta no ayuda a nadie.
    let intentos = 0;
    await expect(
      conReintentoDeConexion(
        async () => {
          intentos++;
          throw new Error('Connection terminated unexpectedly');
        },
        { esperaMs: 1 },
      ),
    ).rejects.toThrow();
    expect(intentos).toBe(2);
  });

  it('avisa del primer fallo aunque el segundo intento salga bien', async () => {
    // Si no se avisa, un pooler que tarda en despertar en CADA despliegue
    // queda invisible: todo responde 201 y nadie sabe que hubo que
    // reintentar.
    const avisos: unknown[] = [];
    await conReintentoDeConexion(
      (() => {
        let n = 0;
        return async () => {
          if (n++ === 0) throw new Error('Connection terminated due to connection timeout');
          return 'ok';
        };
      })(),
      { esperaMs: 1, avisar: (e) => avisos.push(e) },
    );
    expect(avisos).toHaveLength(1);
  });

  it('no espera nada cuando la primera entra', async () => {
    const t = vi.fn(async () => 'ok');
    expect(await conReintentoDeConexion(t)).toBe('ok');
    expect(t).toHaveBeenCalledTimes(1);
  });
});
