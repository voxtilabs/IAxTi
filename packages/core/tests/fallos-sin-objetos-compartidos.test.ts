import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuenteLimpia } from '../src/testing/fuente-limpia';

const raiz = join(__dirname, '../../..');
const pruebas = [
  'packages/modules/payments/tests/aviso-de-pago.test.ts',
  'apps/workers/tests/outbound-vigencia.test.ts',
];
const creaObjeto = (fuente: string) =>
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:TRIGGER|FUNCTION|PROCEDURE)\b/i.test(fuenteLimpia(fuente));

// La guarda to_regclass de arranque (#804) solo detecta que desapareció una
// tabla: un trigger nuevo no cambia ese resultado. Esta guarda acota los DOS
// arneses de #910; no pretende prohibir fixtures de esquema en pruebas de DB.
describe('fallos inyectados sin objetos compartidos (#910)', () => {
  it.each(pruebas)('%s no crea funciones ni triggers para provocar un fallo', (archivo) => {
    expect(creaObjeto(readFileSync(join(raiz, archivo), 'utf8'))).toBe(false);
  });

  it.each([
    'CREATE TRIGGER falla BEFORE INSERT ON outbox EXECUTE FUNCTION falla()',
    'CREATE OR REPLACE FUNCTION falla() RETURNS trigger LANGUAGE plpgsql',
    'CREATE CONSTRAINT TRIGGER falla AFTER UPDATE ON messages',
  ])('detecta el DDL que se quiere evitar: %s', (sql) => {
    expect(creaObjeto(`await cliente.query(${JSON.stringify(sql)});`)).toBe(true);
  });

  it('no confunde un comentario explicativo con SQL ejecutable', () => {
    expect(creaObjeto('// CREATE TRIGGER falla\n/* CREATE FUNCTION falla() */\nawait cliente.query("SELECT 1");')).toBe(false);
  });
});
