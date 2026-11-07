import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comoLinea, esquemaVsCodigo, valoresQueAceptaElEsquema } from '../src/esquema-vs-codigo';

const RAICES_SQL = ['../modules', '../../apps'];
const RAICES_TS = ['../modules', '../../apps', '../core/src', '../ui'];

const temporales: string[] = [];
function caso(sql: string, ts: string): { sql: string[]; ts: string[] } {
  const raiz = mkdtempSync(join(tmpdir(), 'esquema-vs-codigo-'));
  temporales.push(raiz);
  mkdirSync(join(raiz, 'migrations'));
  writeFileSync(join(raiz, 'migrations', '0001_prueba.sql'), sql);
  writeFileSync(join(raiz, 'codigo.ts'), ts);
  return { sql: [raiz], ts: [raiz] };
}
afterAll(() => {
  for (const r of temporales) rmSync(r, { recursive: true, force: true });
});

describe('lo que el esquema acepta contra lo que el código produce (#1278)', () => {
  it('no queda ninguna divergencia en el repo', () => {
    const divergencias = esquemaVsCodigo(RAICES_SQL, RAICES_TS);
    expect(
      divergencias.map(comoLinea),
      'Una lista cerrada quedó declarada dos veces y las copias se separaron.\n' +
        'Si el código produce un valor que la base rechaza, el INSERT aborta la\n' +
        'transacción COMPLETA y se pierde todo lo que iba con ella.\n' +
        'Arreglo: alinear el CHECK con la lista del código en una migración nueva.',
    ).toEqual([]);
  });

  // Esta guarda no lleva lista base a propósito: hoy la deuda es cero, y una
  // lista de excepciones vacía es una invitación a escribir la primera.
  it('la lista está vacía porque no hay deuda, no porque no mire', () => {
    expect(valoresQueAceptaElEsquema(RAICES_SQL).length).toBeGreaterThan(40);
  });

  it('caza el defecto que la motivó: el código produce lo que la base rechaza', () => {
    // Reproduce #1266 tal como estaba: `TIPOS` con video y reaccion, el CHECK sin ellos.
    const { sql, ts } = caso(
      `CREATE TABLE IF NOT EXISTS messages (
         type text NOT NULL CHECK (type IN ('texto','imagen','audio','documento','ubicacion')),
         body text
       );`,
      `export const TIPOS = ['texto','imagen','audio','documento','ubicacion','video','reaccion'] as const;`,
    );
    const d = esquemaVsCodigo(sql, ts);
    expect(d).toHaveLength(1);
    expect(d[0].gravedad).toBe('rompe');
    expect(d[0].rechazados).toEqual(['video', 'reaccion']);
    expect(d[0].columna).toBe('messages.type');
  });

  it('distingue la dirección: lo que la base acepta y el código no nombra no rompe nada hoy', () => {
    const { sql, ts } = caso(
      `CREATE TABLE IF NOT EXISTS pagos (
         status text NOT NULL CHECK (status IN ('creado','enviado','pagado','vencido'))
       );`,
      `type EstadoDePago = 'creado' | 'enviado' | 'pagado';`,
    );
    const d = esquemaVsCodigo(sql, ts);
    expect(d).toHaveLength(1);
    expect(d[0].gravedad).toBe('sin_manejar');
    expect(d[0].sinManejar).toEqual(['vencido']);
  });

  it('lee el CHECK vigente y no el que se reemplazó', () => {
    // Es la forma en que este repo corrige un CHECK, y la razón de que mirar
    // el texto de las migraciones sin ordenarlas dé la respuesta de ayer.
    const { sql } = caso(
      `CREATE TABLE IF NOT EXISTS messages (
         type text NOT NULL CHECK (type IN ('texto','imagen'))
       );
       ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
       ALTER TABLE messages ADD CONSTRAINT messages_type_check
         CHECK (type IN ('texto','imagen','video'));`,
      '',
    );
    expect(valoresQueAceptaElEsquema(sql)).toEqual([
      { donde: 'messages.type', valores: ['texto', 'imagen', 'video'] },
    ]);
  });

  it('no inventa un par con una lista que solo se parece de lejos', () => {
    // El falso positivo que tuvo la primera versión: `saved_filters.view`
    // emparejado con las 58 tablas que exporta una cuenta, por tres nombres
    // en común.
    const { sql, ts } = caso(
      `CREATE TABLE IF NOT EXISTS saved_filters (
         view text NOT NULL CHECK (view IN ('contactos','negocios','conversaciones'))
       );`,
      `export const TABLAS = ['contactos','negocios','conversaciones','tags','companies',
         'custom_fields','messages','assignments','pipelines','stages','products'] as const;`,
    );
    expect(esquemaVsCodigo(sql, ts)).toEqual([]);
  });
});
