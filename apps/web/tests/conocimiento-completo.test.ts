import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Las dos rutas de conocimiento que no llamaba nadie (#447).
 *
 * `POST /knowledge/sources/:id/reindex`: una fuente que falló al procesar o
 * que venció solo se podía arreglar borrándola y volviendo a subirla, con
 * lo que se perdía su historial.
 *
 * `GET /knowledge/products`: el catálogo con precio y stock EXACTOS es lo
 * único que la IA no inventa nunca, y la pantalla de prueba mostraba solo
 * los pasajes de texto. Quien probaba «¿cuánto cuesta X?» veía lo que el
 * texto dice del precio, no el precio.
 */
const PANTALLA = readFileSync(join(__dirname, '..', 'components', 'conocimiento.tsx'), 'utf8');

describe('reindexar una fuente', () => {
  it('se ofrece solo en la que no está sirviendo', () => {
    // Un botón en todas invita a reindexar lo que ya funciona, y cada
    // reindexado se le paga al proveedor de embeddings.
    expect(PANTALLA).toMatch(/f\.status === 'failed' \|\| f\.status === 'expired'/);
    expect(PANTALLA).toContain('/reindex');
  });

  it('no se puede pedir dos veces la misma', () => {
    expect(PANTALLA).toMatch(/disabled=\{reindexando === f\.id\}/);
  });
});

describe('probar qué encontraría la IA', () => {
  it('muestra el catálogo junto a los pasajes, no por separado', () => {
    // El caso que más importa es cuando el texto habla de un precio y el
    // catálogo tiene otro: separados, nadie lo nota.
    expect(PANTALLA).toContain('/knowledge/products?q=');
    expect(PANTALLA).toMatch(/Promise\.all\(\[/);
  });

  it('el catálogo va primero: el precio exacto manda sobre el texto', () => {
    const iProductos = PANTALLA.indexOf('Del catálogo, con precio exacto');
    const iHits = PANTALLA.indexOf('resultado.hits');
    expect(iProductos).toBeGreaterThan(0);
    expect(iProductos).toBeLessThan(iHits);
  });

  it('distingue "sin precio" de un precio cero, y "sin stock declarado" de cero', () => {
    // Un producto sin precio cargado y uno que vale $0 no son lo mismo, y
    // el asistente responde distinto a cada uno.
    expect(PANTALLA).toMatch(/p\.price === null \? 'sin precio'/);
    expect(PANTALLA).toMatch(/p\.stock === null \? 'sin stock declarado'/);
  });

  it('si el catálogo falla, la prueba sigue sirviendo', () => {
    // Sin `knowledge.read` sobre productos, o sin catálogo cargado, los
    // pasajes igual se ven: media respuesta es mejor que un error.
    expect(PANTALLA).toMatch(/knowledge\/products[\s\S]{0,200}catch\(\(\) => \[\]\)/);
  });
});
