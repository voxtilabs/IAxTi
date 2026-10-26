import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La raíz, para importar el generador por ruta COMPUTADA.
 *
 * Con el especificador escrito literal, `tsc` pide un `.d.ts` del `.mjs` y
 * falla con TS7016. Es el mismo camino que usa la guarda del catálogo de
 * herramientas (`catalogo-de-herramientas.test.ts:100`), por la misma razón.
 */
const RAIZ = join(__dirname, '..', '..', '..');
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { campaignRoutes } from '../../../packages/sdk/src/campaign-routes.generated';

let app: INestApplication;
let paths: Record<string, Record<string, { operationId: string }>>;
let documento: unknown;
beforeAll(async () => {
  app = await createApp();
  await app.listen(0);
  documento = await (await fetch(`${urlDeLaApp(app)}/docs-json`)).json();
  paths = (documento as { paths: typeof paths }).paths;
});
afterAll(async () => { await app.close(); });

describe('SDK de campañas contra el OpenAPI real (#348)', () => {
  for (const [id, route] of Object.entries(campaignRoutes)) {
    it(id, () => {
      expect(paths[route.path]?.[route.method.toLowerCase()]?.operationId).toBe(id);
    });
  }

  /**
   * Y que el archivo generado se pueda REPRODUCIR desde su generador (#832).
   *
   * Lo que había comprobaba que cada ruta del archivo exista en el OpenAPI —o
   * sea, que no sobre ninguna— y no que no FALTE ninguna. Durante un día hubo
   * dos generadores con salidas distintas: el viejo tenía doce operaciones y
   * le faltaban `detener` y `seguir`, así que correrlo —y el README mandaba a
   * correr ese— borraba del SDK el botón Detener y el Seguir de una campaña a
   * medias, y estas pruebas seguían verdes porque las doce que quedaban sí
   * existían.
   *
   * Es el mismo patrón que el catálogo de herramientas del Agente General: un
   * archivo generado sin una prueba que lo reproduzca se queda viejo desde el
   * commit siguiente, y la cabecera que dice «no editar a mano» no lo impide.
   */
  it('el archivo generado está al día con el generador', async () => {
    const { DESTINO, rutasDesdeOpenapi, textoDelArchivo } = await import(
      join(RAIZ, 'scripts/generate-campaigns.mjs')
    );
    const esperado = textoDelArchivo(rutasDesdeOpenapi(documento));
    const actual = readFileSync(join(RAIZ, DESTINO), 'utf8');
    expect(
      actual,
      'El archivo de rutas del SDK quedó viejo. Corre:\n' +
        '  curl -s localhost:3001/docs-json > /tmp/iaxti-openapi.json\n' +
        '  node scripts/generate-campaigns.mjs /tmp/iaxti-openapi.json',
    ).toBe(esperado);
  });

  it('y el generador falla con el nombre cuando una operación no está', async () => {
    // Anti-vacuidad del de arriba: si `rutasDesdeOpenapi` devolviera algo para
    // cualquier entrada, la comparación byte a byte no mediría nada.
    const { rutasDesdeOpenapi } = await import(join(RAIZ, 'scripts/generate-campaigns.mjs'));
    expect(() => rutasDesdeOpenapi({ paths: {} })).toThrow(/CampanasController_detener/);
  });
});
