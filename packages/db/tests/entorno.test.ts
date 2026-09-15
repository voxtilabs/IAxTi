import { describe, expect, it } from 'vitest';
import { createPool } from '../src/client';

/**
 * El guardián del agujero que tapó dos bugs reales (#183).
 *
 * `turbo` corre las tareas con entorno ESTRICTO: si `DATABASE_URL` deja de
 * estar declarada en `passThroughEnv`, los tests vuelven a correr sin base y
 * todo lo que dependa de ella se salta en silencio. Eso escondió un 500 en
 * producción (#162) y el día en UTC del tablero (#182).
 *
 * Vive como TEST y no como paso de CI a propósito: un paso posterior que
 * mira la base da falso positivo cuando turbo sirve los tests desde caché
 * —en un PR de solo documentación no corre nada y la base queda vacía—.
 * Como test, viaja con la misma caché que protege: si los tests corrieron,
 * esto corrió.
 */
describe('la suite corre contra una base de verdad', () => {
  it('DATABASE_URL está declarada y responde', async () => {
    // El valor por defecto de los tests apunta a localhost, así que
    // "conecta" no alcanza como prueba: lo que se verifica es que la
    // variable LLEGÓ, que es justo lo que turbo dejaba de pasar.
    expect(
      process.env.DATABASE_URL,
      'Sin DATABASE_URL los tests corren sin base y los fallos se vuelven invisibles. ' +
        'Revisa `passThroughEnv` en la tarea `test` de turbo.json.',
    ).toBeTruthy();

    const pool = createPool();
    try {
      const r = await pool.query('SELECT 1 AS uno');
      expect(r.rows[0].uno).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
