import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El isotipo de IAxTi no aparece dos veces en la misma pantalla (#1159).
 *
 * Medido en `/ajustes/canales`: aparecía TRES veces en un scroll —dos a 82 px
 * y uno a 45—, porque esa pantalla tiene tres paneles que pueden estar vacíos
 * a la vez y cada `EstadoVacio` traía el suyo. La misma marca repetida en la
 * misma pantalla, y en dos tamaños distintos, se lee como relleno.
 *
 * La regla quedó en `EstadoVacio`: el isotipo es para cuando el vacío ES la
 * pantalla, no para un panel vacío dentro de una pantalla con contenido. Eso
 * ya tenía nombre —`compacto`— y lo que faltaba era usarlo.
 *
 * Mesón (ADR-0034, #1346) fue un paso más: el jelly es del MARCO —barra,
 * acceso, portada— y ningún vacío lo trae. En estas rutas el contenido tiene
 * CERO isotipos; si vuelve uno, volvió el adorno.
 *
 * Se cuenta sobre la pantalla renderizada y no leyendo el código porque el
 * defecto no está en ningún archivo: está en que tres componentes correctos
 * coinciden en una ruta. Ninguna guarda de fuente lo ve.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

const RUTAS = ['/ajustes/canales', '/ajustes/ia/detalle', '/ajustes/conocimiento', '/agenda',
  '/campanas', '/empresas', '/contactos', '/oportunidades', '/pendientes', '/reportes',
  '/ajustes/etiquetas', '/ajustes/campos', '/ajustes/plantillas', '/ajustes/automatizaciones'];

test('ninguna pantalla de trabajo muestra el isotipo en el contenido', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tableTenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'admin@e2e.cl' },
    }));
  }, auth);

  const repetidas: string[] = [];
  for (const ruta of RUTAS) {
    await page.goto(ruta, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    // Solo el contenido: el isotipo de la barra lateral es la identidad del
    // producto y está en todas las pantallas a propósito.
    const cuantos = await page.locator('main .pulso-jelly').count();
    if (cuantos > 0) repetidas.push(`${ruta}: ${cuantos} veces`);
  }

  expect(
    repetidas,
    'El isotipo apareció dentro del contenido. En Mesón es del marco (barra, ' +
      'acceso, portada); un estado vacío dice qué va a aparecer y la acción.',
  ).toEqual([]);
});
