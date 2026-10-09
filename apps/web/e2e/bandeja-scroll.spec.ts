import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));

async function documentoAjustado(page: Page) {
  // Se intenta desplazar el DOCUMENTO, no solo comprobar un contenedor. Y el
  // intento va DENTRO del sondeo (#636): desplazar una vez y después sondear
  // deja pasar el contenido que crece tarde —el que llega por `next/dynamic`—,
  // porque el empujón ocurrió cuando la página todavía era corta.
  await expect.poll(() => page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return {
      y: window.scrollY,
      extraY: document.documentElement.scrollHeight - window.innerHeight,
      extraX: document.documentElement.scrollWidth - window.innerWidth,
    };
  })).toEqual({ y: 0, extraY: 0, extraX: 0 });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 768, height: 768 }, { width: 360, height: 640 }]) {
  test(`Bandeja mantiene el scroll en sus paneles a ${viewport.width} px (#429)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript((auth) => {
      localStorage.setItem('iaxti-tenant', auth.tenantId);
      localStorage.setItem('sb-127-auth-token', JSON.stringify({
        access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
        user: { id: auth.userId, aud: 'authenticated', email: 'scroll@e2e.cl' },
      }));
    }, auth);
    // Volumen determinista sin crear conversaciones o mensajes en la BD.
    // Auth, módulos, ficha y permisos usan la API local del runner.
    await page.route('**/v1/conversations', async (route) => {
      const response = await route.fetch({ url: `${route.request().url()}/${auth.conversationId}` });
      const base = await response.json();
      expect(base.id).toBe(auth.conversationId);
      await route.fulfill({ json: { items: Array.from({ length: 50 }, (_, i) => ({
        ...base, id: i === 0 ? base.id : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        contactName: `Contacto de prueba ${String(i + 1).padStart(2, '0')}`,
      })) } });
    });
    // `messages*` y no `messages`: desde #581 la bandeja pide `?limit=` y, al
    // leer hacia atrás, `&antesDe=`. Un glob sin la cola deja de calzar en
    // cuanto la ruta gana un parámetro, y entonces el intercepto no intercepta:
    // la prueba llama a la API de verdad, el panel queda con un mensaje, no
    // desborda, y falla en `scrollTop > 0` — por un motivo que no tiene nada que
    // ver con el scroll.
    await page.route('**/v1/conversations/*/messages*', (route) => route.fulfill({ json:
      Array.from({ length: 80 }, (_, i) => ({
        id: `mensaje-scroll-${i}`, direction: 'in', type: 'text', deliveryStatus: null,
        authorKind: 'contact', createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        body: `Mensaje de prueba ${i + 1}. Historial largo para comprobar el desplazamiento.`,
      })),
    }));
    let soporte = false;
    await page.route('**/v1/support-status', (route) => route.fulfill({ json: {
      active: soporte, until: soporte ? new Date(Date.now() + 3_600_000).toISOString() : null,
    } }));

    await page.goto('/bandeja');
    const lista = page.getByRole('region', { name: 'Conversaciones', exact: true });
    await expect(lista.getByRole('button', { name: /Contacto de prueba 50/ })).toBeAttached();
    await documentoAjustado(page);
    await lista.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => lista.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: 'Bandeja', exact: true })).toBeInViewport();
    await lista.evaluate((n) => { n.scrollTop = n.scrollHeight; });
    await expect(lista.getByRole('button', { name: /Contacto de prueba 50/ })).toBeInViewport();
    await page.mouse.wheel(0, 4000);
    await documentoAjustado(page);

    // El aviso ocupa altura real; no debe empujar la respuesta fuera de pantalla.
    soporte = true;
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'El soporte de IAxTi' })).toBeVisible();
    await expect(lista.getByRole('button', { name: /Contacto de prueba 01/ })).toBeVisible();
    await documentoAjustado(page);
    await lista.getByRole('button', { name: /Contacto de prueba 01/ }).click();
    const chat = page.getByRole('region', { name: 'Conversación', exact: true });
    const respuesta = page.getByLabel('Mensaje', { exact: true });
    await expect(respuesta).toBeInViewport();
    await documentoAjustado(page);
    const historial = chat.locator('ol').locator('..');
    await expect.poll(() => historial.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
    await historial.hover();
    await page.mouse.wheel(0, -await historial.evaluate((n) => n.scrollHeight));
    await expect.poll(() => historial.evaluate((n) => n.scrollTop)).toBe(0);
    await expect(chat.getByText('Mensaje de prueba 80.', { exact: false })).toBeInViewport();
    await expect(respuesta).toBeInViewport();
    await documentoAjustado(page);
    await respuesta.focus();
    await expect(respuesta).toBeFocused();

    if (viewport.width < 1024) {
      await chat.getByRole('button', { name: 'Ficha', exact: true }).click();
      const ficha = page.getByRole('region', { name: 'Ficha del contacto' });
      await ficha.evaluate((n) => { n.scrollTop = n.scrollHeight; });
      await expect.poll(() => ficha.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
      await documentoAjustado(page);
      await ficha.getByRole('button', { name: 'Volver al chat' }).click();
      await expect(respuesta).toBeInViewport();
    }
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 140 });
    await documentoAjustado(page);
    await expect(respuesta).toBeInViewport();
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Buscar o ir a…', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await documentoAjustado(page);

    // Salir de Bandeja no deja un bloqueo global de scroll en otras rutas.
    await page.goto('/reportes');
    await expect(page.getByRole('heading', { name: 'Cómo va el negocio' })).toBeVisible();

    // Se espera a que el CONTENIDO esté, no a que pase el tiempo (#681).
    //
    // #636 arregló la mitad fácil —desplazar dentro del sondeo— y quedó la
    // espera: el gráfico entra por `next/dynamic`, así que la página nace corta
    // y crece cuando el chunk llega. Sondear `scrollY` mientras eso pasa es
    // medir CUÁNTA CARGA TIENE LA MÁQUINA: con la suite completa encima llega
    // más tarde que el presupuesto del poll, y el viewport que caía cambiaba en
    // cada corrida. Un timeout más grande solo mueve el umbral.
    //
    // El `.or` no es por cautela: con datos, la sección muestra el gráfico; sin
    // movimiento en el período, muestra su estado vacío. Las dos cosas son
    // «esta sección terminó de cargar», y afirmar solo una haría que la prueba
    // dependa de lo que el sembrado dejó en la base.
    const seccion = page.getByRole('region', { name: 'Evolución de conversaciones' });
    await expect(
      seccion
        .getByRole('img', { name: 'Conversaciones nuevas y resueltas por día' })
        .or(seccion.getByText('Todavía no hay movimiento en este período')),
    ).toBeVisible();

    // Y lo que se afirma es la propiedad, no la altura: que NO haya quedado un
    // bloqueo global de scroll. Eso se ve en el `overflow` del documento, que no
    // depende de cuánto contenido llegó ni de cuándo — es exactamente el
    // mecanismo que la bandeja podría dejar pegado al desmontarse.
    const bloqueo = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).overflowY,
      body: getComputedStyle(document.body).overflowY,
    }));
    expect(bloqueo, 'Bandeja dejó el scroll del documento bloqueado en otra ruta').not.toMatchObject(
      { html: 'hidden' },
    );
    expect(bloqueo, 'Bandeja dejó el scroll del documento bloqueado en otra ruta').not.toMatchObject(
      { body: 'hidden' },
    );

    // Con el contenido ya montado, la página de reportes es más alta que la
    // ventana y desplazarse MUEVE. Se desplaza dentro del sondeo (#636): el
    // empujón tiene que ocurrir cuando la página ya es larga.
    await expect
      .poll(() =>
        page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          return window.scrollY;
        }),
      )
      .toBeGreaterThan(0);
  });
}
