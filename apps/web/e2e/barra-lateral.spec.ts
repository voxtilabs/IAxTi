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
  /**
   * Una sola pasada por el DOM, y no `count()` y después leer uno por uno.
   *
   * La versión anterior hacía N+1 viajes al navegador: contaba, y después
   * pedía el texto de cada índice. Si la barra se vuelve a dibujar entre el
   * conteo y la lectura —y se vuelve a dibujar, el armazón reacciona al
   * negocio— el índice que ya se tenía apunta a un nodo que quedó desprendido,
   * Playwright se queda esperándolo y la prueba muere en el timeout de 60 s.
   *
   * Lo vi en #789: la prueba pasó 1 de 3 corridas y el rojo decía «waiting for
   * locator(...).nth(11)» sobre una barra que tiene 11 destinos. No era la
   * barra, era la forma de leerla — y el síntoma apuntaba al menú, que es lo
   * caro de un rojo así.
   *
   * `evaluateAll` resuelve el locator y lee los textos en el mismo instante,
   * así que lo que vuelve es una foto coherente.
   */
  const items = await page
    .locator('[data-sidebar="menu-button"]')
    .evaluateAll((nodos) => nodos.map((n) => (n.textContent ?? '').trim()));
  return items.filter((t) => t !== '');
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

    // El asistente es lo primero de la barra (#1102): si vuelve a quedar
    // archivado en Configuración, esto se pone rojo. Va antes que la
    // comprobación de las secciones porque es el orden que importa.
    const primero = items[0];
    expect(
      primero,
      'El asistente dejó de ser el primer destino de la barra. IAxTi se llama ' +
        'así por la facilidad de configurarlo, no solo porque atiende: si el ' +
        'agente vuelve a estar bajo Configuración, la interfaz cuenta otra cosa.',
    ).toBe('Tu asistente');

    // Lo que motivó el #635: las 17 pantallas de configuración quedaban detrás
    // de un rótulo idéntico a los que NO se pueden tocar, y ahí viven conectar
    // WhatsApp y prender la IA. Se cuenta lo que se VE, no lo que trae la API.
    //
    // «Inteligencia» salió de esta lista en #1102, y no porque se escondiera:
    // el asistente era su única entrada visible para esta supervisora, y ahora
    // vive arriba. Las otras dos de esa sección —Conocimiento y
    // Automatizaciones— piden permisos que este usuario no tiene, así que la
    // sección no tiene nada que ofrecerle y no aparecer es lo correcto.
    for (const seccion of ['Canales', 'Tu negocio', 'Cuenta']) {
      await expect(
        page.getByRole('link', { name: seccion, exact: true }),
        `"${seccion}" no está a la vista en la barra: la configuración volvió a ` +
          'quedar escondida detrás de un rótulo.',
      ).toBeVisible();
    }
  });

  test('la barra entera cabe a 1440x900: ningún grupo queda cortado', async ({ page }) => {
    // El presupuesto vertical de la barra, medido y sostenido (#1108).
    //
    // «CONFIGURACIÓN (3)» quedaba cortado por la mitad contra el filete del
    // pie. Se alcanzaba con scroll, pero un rótulo partido no se lee como «hay
    // más abajo»: se lee como interfaz rota, y es lo primero que se ve en
    // CUALQUIER pantalla del producto.
    //
    // Lo que midió de dónde venía: 315 px de cromo (cabecera 187 + pie 128)
    // para 729 px de navegación, y 200 de esos 729 eran rótulo y relleno de
    // grupo en vez de entradas. Con el aire apretado en `pulso-vivo.css`,
    // cabecera 127 + pie 99 y la navegación entra con 32 px de sobra.
    //
    // ESTA PRUEBA SE VA A PONER ROJA el día que alguien agregue una entrada de
    // navegación, y está bien que lo haga: 32 px no alcanzan para una fila de
    // 42. Cuando pase, las salidas son plegar un grupo más, no apretar
    // `menu-button` —42 px es el tamaño de control de Pulso y bajarlo sería
    // arreglar la barra rompiendo el sistema—, o decidir que a 900 px de alto
    // la barra scrollea y el recorte cae donde no parta un rótulo.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^Configuración \(/ })).toBeVisible();
    const holgura = await page.evaluate(() => {
      const c = document.querySelector('[data-sidebar="content"]') as HTMLElement;
      const ultimo = c.lastElementChild as HTMLElement;
      return Math.round(c.getBoundingClientRect().bottom - ultimo.getBoundingClientRect().bottom);
    });
    expect(holgura, 'el último grupo de la barra se sale del área visible a 1440x900').toBeGreaterThanOrEqual(0);
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
