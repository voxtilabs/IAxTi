import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Las conversaciones anteriores vuelven (#1131, ADR-0029).
 *
 * Lo pidió el dueño del producto: «que sea como abrir ChatGPT o Claude desde
 * el celular y pueda ver mis anteriores conversaciones». Pedir la función es
 * elegir guardarlas.
 *
 * Lo que de verdad protege esto no es la comodidad: el agente PROPONE
 * acciones y el humano las aprueba. Una propuesta sin resolver que
 * desaparece deja al dueño sin saber qué le habían ofrecido — así que la
 * prueba no comprueba solo que vuelva el texto, sino que vuelva el ESTADO.
 */
const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

test.use({ viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((a) => {
    localStorage.setItem('iaxti-tenant', a.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: a.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: a.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, auth);
  await page.route('**/v1/agente-general', (r) =>
    r.fulfill({ json: { texto: 'Lo dejé anotado.', pasos: [], propuesta: null, truncada: false } }));
});

test('lo hablado sobrevive a RECARGAR y vuelve desde la lista', async ({ page }) => {
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  const loQueDije = `Armá mis embudos ${Date.now()}`;
  await panel.getByLabel('Pídele algo a IAxTi').fill(loQueDije);
  await panel.getByRole('button', { name: 'Pedir', exact: true }).click();
  await expect(panel.getByText('Lo dejé anotado.')).toBeVisible();

  // Lo que el hilo en memoria NO resiste.
  await page.reload();
  await expect(panel.getByText(loQueDije)).toHaveCount(0);

  await page.getByRole('button', { name: 'Conversaciones' }).click();
  // `exact` porque el botón de borrar lleva el título en su nombre accesible
  // —«Borrar la conversación «…»»—, que es correcto para quien usa lector de
  // pantalla y hace que el selector por subcadena case con los dos.
  await page.getByRole('button', { name: loQueDije, exact: true }).click();
  await expect(panel.getByText(loQueDije)).toBeVisible();
  await expect(panel.getByText('Lo dejé anotado.')).toBeVisible();
});

test('una propuesta vuelve CON su estado, no solo con su texto', async ({ page }) => {
  // El caso que justifica guardar: una propuesta sin resolver que desaparece
  // deja al dueño sin saber qué le habían ofrecido.
  await page.route('**/v1/agente-general', (r) =>
    r.fulfill({ json: {
      texto: 'Te propongo esto.', pasos: [],
      propuesta: { herramienta: 'crm.tags.create', descripcion: 'Crear la etiqueta «VIP»',
        metodo: 'POST', ruta: '/v1/tags', permiso: 'crm.tags.manage', argumentos: { nombre: 'VIP' } },
      truncada: false,
    } }));
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  const loQueDije = `Creá una etiqueta ${Date.now()}`;
  await panel.getByLabel('Pídele algo a IAxTi').fill(loQueDije);
  await panel.getByRole('button', { name: 'Pedir', exact: true }).click();
  await expect(panel.getByText('Necesito tu visto bueno')).toBeVisible();

  await panel.getByRole('button', { name: 'Mejor no' }).click();
  await expect(panel.getByText('No se hizo')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Conversaciones' }).click();
  await page.getByRole('button', { name: loQueDije, exact: true }).click();
  // Vuelve resuelta: si se guardara solo el texto, diría «Necesito tu visto
  // bueno» y ofrecería decidir algo que ya se decidió.
  await expect(panel.getByText('No se hizo')).toBeVisible();
  await expect(panel.getByText('Necesito tu visto bueno')).toHaveCount(0);
});

test('«Nueva» deja la pantalla limpia sin borrar la anterior', async ({ page }) => {
  await page.goto('/ajustes/ia');
  const panel = page.getByRole('region', { name: 'Conversación con IAxTi' });
  const loQueDije = `Algo que quiero conservar ${Date.now()}`;
  await panel.getByLabel('Pídele algo a IAxTi').fill(loQueDije);
  await panel.getByRole('button', { name: 'Pedir', exact: true }).click();
  await expect(panel.getByText('Lo dejé anotado.')).toBeVisible();

  await page.getByRole('button', { name: 'Nueva' }).click();
  await expect(panel.getByText(loQueDije)).toHaveCount(0);

  await page.getByRole('button', { name: 'Conversaciones' }).click();
  await expect(page.getByRole('button', { name: loQueDije, exact: true })).toBeVisible();
});
