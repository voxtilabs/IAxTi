import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
}

const auth: Auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

// La sesión se inyecta como la guardaría supabase-js, igual que el resto de la
// suite: el token lo firmó run-e2e.mjs y la API lo verifica contra el JWKS local.
test.beforeEach(async ({ page }) => {
  const sesion = {
    access_token: auth.accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e',
    user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
  };
  await page.addInitScript(
    ([clave, valor, tenant]) => {
      localStorage.setItem(clave, valor);
      localStorage.setItem('iaxti-tenant', tenant);
    },
    ['sb-127-auth-token', JSON.stringify(sesion), auth.tenantId] as const,
  );
});

/**
 * «No veo los botones en la izquierda.»
 *
 * La barra lateral se arma con lo que devuelve `GET /me/modules`, así que
 * puede quedar vacía sin que nada falle: la pantalla carga, el encabezado está,
 * y donde iba el menú no hay nada. Toda la suite corre en viewport de celular
 * (es el criterio de salida de la Fase 2), y en celular la barra de shadcn es un
 * panel que sale de costado — o sea que el caso de escritorio, que es donde se
 * mira el menú, no lo estaba viendo NADIE.
 *
 * Esta prueba mira las dos anchuras y cuenta destinos de verdad.
 */
async function destinos(page: import('@playwright/test').Page): Promise<string[]> {
  const enlaces = page.locator('[data-sidebar="menu-button"]');
  const n = await enlaces.count();
  const salida: string[] = [];
  for (let i = 0; i < n; i++) salida.push(((await enlaces.nth(i).textContent()) ?? '').trim());
  return salida.filter((t) => t !== '');
}

test.describe('la barra lateral tiene destinos', () => {
  test('en escritorio', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    // El encabezado de la barra existe siempre; lo que se vacía es el contenido.
    await expect(page.getByRole('link', { name: 'IAxTi, inicio' })).toBeVisible();

    const items = await destinos(page);
    console.log(`escritorio · destinos en la barra (${items.length}):`, JSON.stringify(items));
    await page.screenshot({ path: 'e2e/capturas/barra-escritorio.png', fullPage: false });

    expect(
      items.length,
      'La barra lateral no tiene ningún destino. Sale de GET /me/modules: o la ' +
        'llamada falló, o el registro no trae módulos activos.',
    ).toBeGreaterThan(3);

    // Lo que motivó el #635: las 17 pantallas de configuración quedaban detrás
    // de un rótulo idéntico a los que NO se pueden tocar, y ahí viven conectar
    // WhatsApp y prender la IA. Se cuenta lo que se VE, no lo que trae la API.
    for (const seccion of ['Inteligencia', 'Canales', 'Tu negocio', 'Cuenta']) {
      await expect(
        page.getByRole('link', { name: seccion, exact: true }),
        `"${seccion}" no está a la vista en la barra: la configuración volvió a ` +
          'quedar escondida detrás de un rótulo.',
      ).toBeVisible();
    }
  });

  test('el grupo que se pliega SE VE que se pliega, y se recuerda', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const boton = page.getByRole('button', { name: /^Configuración \(/ });
    // Es un control, no un rótulo: tiene rol de botón y dice si está abierto.
    await expect(boton).toHaveAttribute('aria-expanded', 'true');
    await expect(boton.locator('svg')).toBeVisible();

    await boton.click();
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'Canales', exact: true })).toHaveCount(0);

    // Y se recuerda: antes era useState a secas y se volvía a plegar en cada
    // navegación, así que abrirlo no servía de nada dos clics después.
    await page.goto('/contactos');
    await expect(page.getByRole('button', { name: /^Configuración \(/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('en celular se puede abrir', async ({ page }) => {
    await page.goto('/');
    // En celular la barra está fuera de pantalla: sin el botón que la abre, no
    // hay ninguna forma de llegar al menú.
    const abrir = page.getByRole('button', { name: /barra|sidebar|menú/i });
    await expect(abrir).toBeVisible();
    await abrir.click();
    const items = await destinos(page);
    console.log(`celular · destinos tras abrir (${items.length}):`, JSON.stringify(items));
    await page.screenshot({ path: 'e2e/capturas/barra-celular.png' });
    expect(items.length).toBeGreaterThan(3);
  });
});
