import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import {
  PAR,
  cambioDelDia,
  cambiosDelRango,
  guardarCambios,
  traerDolarObservado,
} from '../application/cambio';
import { aPesos, seConvirtio } from '../domain/cambio';

/**
 * El dólar, con la fecha de SU día (#796).
 *
 * La regla que decide todo: un costo de marzo se convierte con el dólar de
 * marzo. Convertirlo con el de hoy haría que el mismo mes rinda distinto según
 * el día en que se abra el panel, y un número que se mueve solo no se puede
 * defender frente al cliente.
 *
 * Y cuando el valor de ese día no existe —el Banco Central no publica sábados,
 * domingos ni feriados— no se convierte con el de otra fecha: se dice que
 * falta. Las tres pruebas del dominio son esas tres frases.
 */
let pool: Pool;
const DIA = '2026-03-12';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  await pool.query('DELETE FROM fx_rates WHERE pair = $1 AND day >= $2::date', [PAR, '2026-03-01']);
});
afterAll(async () => {
  await pool.query('DELETE FROM fx_rates WHERE pair = $1 AND day >= $2::date', [PAR, '2026-03-01']);
  await pool.end();
});

describe('convertir, o decir que no se puede', () => {
  const cambio = { valor: 952.3, fecha: DIA, fuente: 'Banco Central (mindicador.cl)' };

  it('convierte con el dólar DE ESE DÍA y redondea al peso', () => {
    const r = aPesos(12.4, cambio, DIA);
    expect(seConvirtio(r)).toBe(true);
    // 12,4 × 952,3 = 11.808,52 → 11.809, y no «$11.808,52»: Chile no tiene
    // centavos y mostrarlos es precisión inventada.
    expect(r).toMatchObject({ clp: 11_809 });
  });

  it('sin dólar de ese día no convierte: lo DICE, con el día que falta', () => {
    const r = aPesos(12.4, null, DIA);
    expect(seConvirtio(r)).toBe(false);
    expect(r).toEqual({ falta: true, dia: DIA });
  });

  it('y con el dólar de OTRO día tampoco, que es el error que importa', () => {
    // Esto es el modo de falla que el issue viene a cerrar: el costo de marzo
    // convertido con el dólar de hoy. Si pasara, el histórico se movería solo
    // cada mañana y nadie lo notaría: el número sigue pareciendo un número.
    const deOtroDia = { ...cambio, fecha: '2026-10-16' };
    expect(aPesos(12.4, deOtroDia, DIA)).toEqual({ falta: true, dia: DIA });
  });

  it('el cero se convierte, que no es lo mismo que faltar', () => {
    // Un tenant que no gastó nada tiene costo 0, y eso es un dato. Si el cero
    // cayera en «falta», el panel diría «no se pudo convertir» a quien
    // simplemente no gastó.
    expect(aPesos(0, cambio, DIA)).toMatchObject({ clp: 0 });
  });
});

describe('traer la serie de mindicador', () => {
  const respuesta = (cuerpo: unknown, ok = true, status = 200) =>
    (async () => ({ ok, status, json: async () => cuerpo })) as unknown as typeof fetch;

  it('se queda con el día que ELLOS escriben, no con el instante interpretado', async () => {
    // Publican `2026-10-16T03:00:00.000Z`, que son las 00:00 del 16 en
    // Santiago. Interpretarlo como instante y después sacarle el día es
    // jugar con el offset; cortar la cadena es leer lo que dice.
    const valores = await traerDolarObservado(
      respuesta({ serie: [{ fecha: '2026-10-16T03:00:00.000Z', valor: 984.09 }] }),
    );
    expect(valores).toEqual([{ day: '2026-10-16', value: 984.09 }]);
  });

  it('descarta los puntos inservibles y se queda con el resto', async () => {
    const valores = await traerDolarObservado(
      respuesta({
        serie: [
          { fecha: '2026-10-16T03:00:00.000Z', valor: 984.09 },
          { fecha: '2026-10-15T03:00:00.000Z' }, // sin valor
          { valor: 987.03 }, // sin fecha
          { fecha: '2026-10-14T03:00:00.000Z', valor: 0 }, // no es un cambio
        ],
      }),
    );
    expect(valores).toEqual([{ day: '2026-10-16', value: 984.09 }]);
  });

  it('un error de la fuente se cuenta, no se disfraza de serie vacía', async () => {
    // Devolver `[]` dejaría la tabla sin el valor de hoy y el repetible
    // diciendo «traje 0» como si ese fuera el estado del mundo.
    await expect(traerDolarObservado(respuesta({}, false, 503))).rejects.toThrow('503');
  });
});

describe('guardar y leer, contra la base', () => {
  it('guarda, corrige cuando la fuente corrige, y no cuenta lo que no cambió', async () => {
    expect(await guardarCambios(pool, [{ day: DIA, value: 952.3 }])).toBe(1);
    // Segunda pasada con el MISMO valor: no cambió nada y no se cuenta. El
    // `WHERE value <> EXCLUDED.value` es lo que hace que el log diga algo.
    expect(await guardarCambios(pool, [{ day: DIA, value: 952.3 }])).toBe(0);
    // El Banco Central corrige valores publicados: nuestra copia vieja no
    // puede ganarle a la fuente.
    expect(await guardarCambios(pool, [{ day: DIA, value: 953.1 }])).toBe(1);
    expect(await cambioDelDia(pool, DIA)).toEqual({
      valor: 953.1,
      fecha: DIA,
      fuente: 'Banco Central (mindicador.cl)',
    });
  });

  it('un día sin publicar devuelve null, y el dominio sabe qué hacer con eso', async () => {
    // 2026-03-14 es sábado.
    expect(await cambioDelDia(pool, '2026-03-14')).toBeNull();
  });

  it('el rango trae los días que EXISTEN, para no pedirlos de a uno', async () => {
    await guardarCambios(pool, [
      { day: '2026-03-10', value: 940 },
      { day: '2026-03-11', value: 945.5 },
    ]);
    const porDia = await cambiosDelRango(pool, '2026-03-09', '2026-03-12');
    expect([...porDia.keys()].sort()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(porDia.get('2026-03-11')?.valor).toBe(945.5);
    // El 9 no está, y preguntar por él no inventa nada.
    expect(porDia.get('2026-03-09')).toBeUndefined();
  });
});
