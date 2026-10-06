import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Llevarse la cartera en CSV (#460).
 *
 * `GET /contacts/exportar` existe desde #248 y no la llamaba nadie: se
 * podía importar una planilla y no sacarla. La contraparte de «trae tu
 * lista» es «llévatela cuando quieras», y sin botón esa promesa dependía
 * de escribirnos.
 */
const CONTACTOS = readFileSync(join(__dirname, '..', 'components', 'crm', 'contactos.tsx'), 'utf8');
const API = readFileSync(join(__dirname, '..', 'lib', 'api.ts'), 'utf8');

describe('exportar la cartera', () => {
  it('el botón vive junto a Importar', () => {
    expect(CONTACTOS).toContain("'/contacts/exportar'");
    // Decía 'Exportar CSV'. Desde #709 el botón principal es Excel y el CSV
    // queda al lado, en fantasma: el CSV sirve para importar a otro sistema,
    // pero casi siempre lo que se quiere es ABRIR la lista — y ahí el CSV falla
    // por el separador y por no tener tipos.
    expect(CONTACTOS).toContain('Exportar Excel');
    expect(CONTACTOS, 'el CSV sigue estando').toMatch(/onClick=\{\(\) => void exportar\(\)\}/);
  });

  it('y la planilla sale por su propia ruta, con su propio ayudante (#709)', () => {
    // `apiDescargar` hace `res.text()`, que para un zip corrompe el archivo en
    // silencio: llega, pesa parecido, y Excel dice que está dañado.
    expect(CONTACTOS).toContain("'/contacts/exportar.xlsx'");
    expect(CONTACTOS).toContain('apiDescargarBinario');
    expect(API).toContain('res.blob()');
  });

  it('no se ofrece con la cartera vacía', () => {
    expect(CONTACTOS).toContain('items?.length === 0');
  });

  it('el CSV no pasa por res.json()', () => {
    // La respuesta es texto: `apiFetch` reventaría justo con la buena.
    expect(CONTACTOS).toContain('apiDescargar');
    expect(API).toContain('await res.text()');
  });

  it('el nombre del archivo sale de la cabecera del servidor', () => {
    // Ahí ya viene con la fecha; inventarlo acá sería repetir la regla en
    // dos lados y que un día dejen de coincidir.
    expect(API).toContain('filename="([^"]+)"');
  });

  it('el texto se respeta tal cual: el BOM lo puso el servidor', () => {
    // Sin él, Excel en español abre la ñ rota y el negocio cree que
    // perdimos su información.
    expect(CONTACTOS).toContain("new Blob([texto], { type: 'text/csv;charset=utf-8' })");
  });
});
