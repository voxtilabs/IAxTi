import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(__dirname, '.auth.json'), 'utf8'));
const baseline = process.env.IAXTI_CAPTURA_ANTES === '1';
const destino = join(__dirname, '../../../docs/evidencias/297', baseline ? 'antes' : 'despues');

// Datos sintéticos de presentación; bandeja.spec.ts recorre además la API real.
for (const modo of ['dia', 'noche']) {
  for (const width of [360, 1280]) {
    test(`densidad y jerarquía a ${width}px en ${modo}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ auth, modo }) => {
        localStorage.setItem('iaxti-tenant', auth.tenantId);
        localStorage.setItem('pulso-mode', modo);
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
          user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
        }));
      }, { auth, modo });
      await page.route('**/v1/conversations', async (route) => {
        await route.fulfill({ json: { items: Array.from({ length: 20 }, (_, i) => ({
          id: `conversacion-${i}`, contactId: `contacto-${i}`, contactName: `Contacto de prueba ${i + 1}`,
          contactPhone: `+5698000${String(i).padStart(4, '0')}`, channel: 'simulador',
          state: 'new', ownerId: null, lastInboundAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(), unansweredSeconds: 180, snoozedUntil: null,
        })), nextCursor: null } });
      });
      await page.goto('/bandeja');
      const filas = page.getByRole('button', { name: /Contacto de prueba/ });
      await expect(filas).toHaveCount(20);
      await page.evaluate((modo) => document.documentElement.setAttribute('data-mode', modo), modo);
      await page.evaluate(() => document.fonts.ready);
      const medidas = await filas.evaluateAll((rows) => {
        const contenedor = rows[0].closest('section')!.getBoundingClientRect();
        return {
          altoFila: rows[0].getBoundingClientRect().height,
          filasEnPanel: rows.filter((r) => r.getBoundingClientRect().bottom <= contenedor.bottom).length,
          visiblesEnPantalla: rows.filter((r) => r.getBoundingClientRect().bottom <= Math.min(contenedor.bottom, window.innerHeight)).length,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      if (!baseline) {
        expect(medidas.overflow).toBe(false);
        expect(medidas.altoFila).toBeLessThanOrEqual(60);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        const titulo = await page.getByRole('heading', { level: 1 }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(titulo).toBeGreaterThanOrEqual(24);
        if (width === 1280) expect(medidas.visiblesEnPantalla).toBeGreaterThanOrEqual(8);
        await filas.first().focus();
        expect(await filas.first().evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
      }
      mkdirSync(destino, { recursive: true });
      writeFileSync(join(destino, `${modo}-${width}.json`), JSON.stringify(medidas, null, 2) + '\n');
      await page.screenshot({ path: join(destino, `${modo}-${width}.png`) });
    });
  }
}

test('la pantalla del asistente abre con su nombre, y el detalle con el suyo', async ({ page }) => {
  // #1125: /ajustes/ia no tenía `EncabezadoDePagina`, así que el único titular
  // con peso de página estaba a dos tercios hacia abajo y decía «Consumo del
  // asistente». La pantalla central del producto se presentaba sin nombre, y
  // lo único que la nombraba en grande era su facturación.
  //
  // #1135 partió la pantalla en dos —la conversación y lo que quedó
  // configurado—, así que la afirmación se parte igual: cada una tiene que
  // abrir con SU nombre y con un solo `h1`.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(({ auth }) => {
    localStorage.setItem('iaxti-tenant', auth.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, { auth });

  await page.goto('/ajustes/ia');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu asistente');
  // Y es una pantalla de chat: el compositor, no una pila de paneles.
  await expect(page.getByLabel('Pídele algo a IAxTi')).toBeVisible();

  await page.goto('/ajustes/ia/detalle');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lo que quedó configurado');
  await expect(page.getByRole('heading', { level: 2, name: 'Consumo del asistente' })).toBeVisible();

  // La línea que dice de qué va la pantalla sigue arriba, no enterrada: en el
  // primer 20% de la altura de la página.
  //
  // La frase cambió en #1157: era «Contesta en WhatsApp con lo que tú le
  // diste: tu catálogo, tus precios, tu agenda. Nunca inventa un dato que no
  // pudo confirmar…», 41 palabras explicando qué hace el asistente en una
  // pantalla que se llama «Lo que quedó configurado». Lo que ahí hace falta es
  // cómo se cambia, no qué es. La afirmación de que la IA no inventa no se
  // perdió: vive en `/ajustes/conocimiento`, que es donde se decide con ella.
  const y = await page.getByText(/Para cambiarlo, pídeselo conversando/).first()
    .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const alto = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(y, 'la línea que dice de qué va la pantalla quedó enterrada').toBeLessThan(alto * 0.2);
});

test('a 360 px nada de la barra superior envuelve', async ({ page }) => {
  // #1127: «Modo noche» era el único control de la barra que no se acortaba,
  // así que se partía en dos líneas — lo único de la bandeja que envolvía, y
  // encima el texto más largo de la barra.
  //
  // Se mide la ALTURA de cada control contra la de una línea, que es lo que
  // distingue «entra» de «entró partido». Mirar si se ve bonito no es una
  // aserción, y `toBeVisible` pasa igual con el texto en dos renglones.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(({ auth }) => {
    localStorage.setItem('iaxti-tenant', auth.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, { auth });
  await page.goto('/bandeja');

  const tema = page.getByRole('button', { name: 'Cambiar entre modo día y modo noche' });
  await expect(tema).toBeVisible();
  const partidos = await page.evaluate(() => {
    const barra = document.querySelector('header') ?? document.body;
    return [...barra.querySelectorAll('button, a')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return false;
        const linea = parseFloat(getComputedStyle(el).lineHeight) || 20;
        // Dos líneas de texto dentro de un control de 46 px de alto: se mide
        // el alto del CONTENIDO, no el del botón.
        const dentro = [...el.childNodes]
          .map((n) => (n instanceof HTMLElement ? n.getBoundingClientRect().height : 0));
        return dentro.some((h) => h > linea * 1.6);
      })
      .map((el) => (el.textContent ?? '').trim().slice(0, 30));
  });
  expect(partidos, 'algo de la barra superior quedó en dos líneas a 360 px').toEqual([]);
});

test('a 360 px el campo del chat muestra su texto entero', async ({ page }) => {
  // #1133: el compositor era una fila y a 360 px le quedaban ~130 px al
  // campo, así que «Pídele lo que necesitas» envolvía a dos líneas dentro de
  // un `rows={1}` y la segunda quedaba cortada por la mitad.
  //
  // Se mide el RECORTE —`scrollWidth`/`scrollHeight` contra lo visible— y no
  // que el campo «se vea»: `toBeVisible` pasa igual con el texto partido, que
  // es exactamente cómo esto llegó a producción.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(({ auth }) => {
    localStorage.setItem('iaxti-tenant', auth.tenantId);
    localStorage.setItem('pulso-mode', 'dia');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
      user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
    }));
  }, { auth });
  await page.goto('/ajustes/ia');

  const campo = page.getByRole('region', { name: 'Conversación con IAxTi' })
    .getByLabel('Pídele algo a IAxTi');
  await expect(campo).toBeVisible();
  const medida = await campo.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    // Con el placeholder puesto, el ancho que el texto PIDE contra el que tiene.
    const sonda = document.createElement('span');
    const s = getComputedStyle(t);
    sonda.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${s.font}`;
    sonda.textContent = t.placeholder;
    document.body.appendChild(sonda);
    const pide = sonda.getBoundingClientRect().width;
    sonda.remove();
    const util = t.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    return { pide: Math.round(pide), util: Math.round(util), recortado: t.scrollHeight > t.clientHeight + 2 };
  });
  expect(medida.recortado, 'el campo recorta su propio contenido').toBe(false);
  expect(medida.util, `«${'Pídele lo que necesitas'}» pide ${medida.pide} px y el campo tiene ${medida.util}`)
    .toBeGreaterThanOrEqual(medida.pide);
});

for (const ruta of ['/', '/contactos', '/agenda', '/pendientes'] as const) {
  test(`${ruta} abre con un solo h1`, async ({ page }) => {
    // #1139: la portada no tenía ninguno. Su rama de bienvenida —la que ve
    // quien no puede leer el estado del negocio— abría con `h2`, así que la
    // primera pantalla del producto no se nombraba a sí misma.
    //
    // Se revisan varias y no solo la que falló: el defecto no era de esa
    // pantalla, era que nadie estaba mirando.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(({ auth }) => {
      localStorage.setItem('iaxti-tenant', auth.tenantId);
      localStorage.setItem('pulso-mode', 'dia');
      localStorage.setItem('sb-127-auth-token', JSON.stringify({
        access_token: auth.accessToken, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'e2e',
        user: { id: auth.userId, aud: 'authenticated', email: 'supervisora@e2e.cl' },
      }));
    }, { auth });
    await page.goto(ruta);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
}
