import { test, expect } from '@playwright/test';
import { comoAdmin } from './como-admin';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Auth {
  accessToken: string;
  userId: string;
  tenantId: string;
  /** El negocio donde la usuaria es ADMIN: el que tiene MÁS entradas (#1142). */
  tableTenantId: string;
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

  test('la barra, en el negocio con MÁS entradas: cabe, o se ve que sigue', async ({ page }) => {
    /*
     * El presupuesto vertical de la barra, medido donde duele (#1108, #1142).
     *
     * «CONFIGURACIÓN» quedaba cortado por la mitad contra el filete del pie.
     * #1108 apretó el aire —cabecera 187→127, pie 128→99— y dejó 32 px de
     * sobra, con un comentario que decía que esto se pondría rojo «el día que
     * alguien agregue una entrada de navegación».
     *
     * Nadie agregó nada. El caso peor YA EXISTÍA: con el negocio donde la
     * usuaria es ADMIN son catorce entradas y cinco secciones de
     * configuración, necesita 762 px y ve 702. Dos quedaban fuera en
     * silencio. La guarda estaba midiendo el tenant cómodo, y una guarda que
     * mide el caso cómodo no mide.
     *
     * Por eso ahora la afirmación es otra, y es la que de verdad importa:
     * catorce entradas de 42 px NO caben, y eso es normal en cualquier CRM.
     * Lo que no puede pasar es que se corte sin decirlo.
     */
    await page.setViewportSize({ width: 1440, height: 900 });
    await comoAdmin(page, auth);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^Configuración \(/ })).toBeVisible();

    const barra = await page.evaluate(() => {
      const c = document.querySelector('[data-sidebar="content"]') as HTMLElement;
      const ultimo = c.lastElementChild as HTMLElement;
      return {
        entradas: c.querySelectorAll('[data-sidebar="menu-button"]').length,
        desborda: c.scrollHeight > c.clientHeight + 1,
        marcada: c.dataset.desborda === 'true',
        atenuada: getComputedStyle(c).maskImage !== 'none',
        holgura: Math.round(c.getBoundingClientRect().bottom - ultimo.getBoundingClientRect().bottom),
      };
    });

    // Que de verdad estamos en el caso peor y no en otro tenant.
    expect(barra.entradas, 'este negocio tendría que ser el de más entradas').toBeGreaterThanOrEqual(13);

    if (barra.desborda) {
      expect(barra.marcada, 'la barra desborda y no quedó marcada: se corta en silencio').toBe(true);
      expect(barra.atenuada, 'la barra desborda y no se atenúa: parece que la lista terminó').toBe(true);
    } else {
      // Si llegara a caber, la pista no debe estar: una señal permanente es ruido.
      expect(barra.marcada).toBe(false);
      expect(barra.holgura, 'cabe, así que nada puede quedar fuera').toBeGreaterThanOrEqual(0);
    }
  });

  test('donde la barra SÍ cabe, no hay pista de desborde', async ({ page }) => {
    // La otra mitad: la atenuación aparece solo cuando hace falta. Sin esto,
    // «marcar cuando desborda» podría ser «marcar siempre» y nadie lo notaría.
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^Configuración \(/ })).toBeVisible();
    const m = await page.evaluate(() => {
      const c = document.querySelector('[data-sidebar="content"]') as HTMLElement;
      return { desborda: c.scrollHeight > c.clientHeight + 1, marcada: c.dataset.desborda === 'true' };
    });
    expect(m.desborda, 'a 1400 px de alto esta barra tendría que caber').toBe(false);
    expect(m.marcada).toBe(false);
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
