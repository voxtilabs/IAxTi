import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cada pantalla tiene un techo de palabras (#1157).
 *
 * Medido el 01-11-2026 recorriendo 19 pantallas como ADMIN: **1.581 palabras**
 * de prosa visible, y la mitad explicaba conceptos en vez de ayudar a decidir.
 * Lo peor no era el total sino la repetición: casi toda pantalla con lista
 * decía lo mismo dos veces —en la línea de apoyo del bloque y de nuevo en el
 * estado vacío, a quince centímetros— porque las dos las escribió alguien que
 * no estaba mirando la otra.
 *
 * El trinquete existe porque esto vuelve solo: un párrafo explicativo nunca
 * se siente caro cuando lo escribís, se siente útil. El costo aparece después
 * y repartido.
 *
 * El techo y el criterio viven en `docs/prosa-por-pantalla.txt`.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

const TECHOS: [string, number][] = readFileSync(
  join(__dirname, '../../../docs/prosa-por-pantalla.txt'), 'utf8',
).split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [ruta, techo] = l.split(/\s+/);
    return [ruta, Number(techo)] as [string, number];
  });

test('ninguna pantalla pasa su techo de prosa', async ({ page }) => {
  expect(TECHOS.length, 'el archivo de techos quedó vacío').toBeGreaterThan(15);
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

  const pasadas: string[] = [];
  for (const [ruta, techo] of TECHOS) {
    await page.goto(ruta, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const medido = await page.evaluate(() => {
      const main = document.querySelector('main') ?? document.body;
      const frases: string[] = [];
      for (const el of main.querySelectorAll('p')) {
        const e = el as HTMLElement;
        // `sr-only` es accesibilidad, no «mucho texto»; y lo que vive dentro
        // de un `label` es el nombre de un control, no prosa sobre él.
        if (e.closest('.sr-only, [aria-hidden="true"], label')) continue;
        if (e.offsetParent === null) continue;
        const t = (e.textContent ?? '').trim();
        if (t.split(/\s+/).length >= 4) frases.push(t);
      }
      return [...new Set(frases)].reduce((a, f) => a + f.split(/\s+/).length, 0);
    });
    if (medido > techo) pasadas.push(`${ruta}: ${medido} palabras, el techo es ${techo}`);
  }

  expect(
    pasadas,
    'Alguna pantalla creció de prosa. Si el párrafo nuevo cambia una decisión ' +
      '—una consecuencia, algo irreversible, una restricción, o qué cuenta un ' +
      'número— sube su techo en docs/prosa-por-pantalla.txt y decilo en el PR. ' +
      'Si explica un concepto, no va en la pantalla: IAxTi lo contesta.',
  ).toEqual([]);
});
