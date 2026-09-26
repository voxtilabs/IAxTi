import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El acceso (#113).
 *
 * GoTrue fuerza `redirect_to` al `site_url` aunque la URL pedida esté en la
 * allowlist. La consecuencia no es un error: es que el operador que entra al
 * panel de plataforma por el enlace del correo aterriza en la app de CLIENTES
 * y se queda mirando una bandeja de conversaciones, preguntándose qué hizo
 * mal. No hizo nada mal.
 *
 * Mientras eso siga así, el panel se entra con el código de 6 dígitos, que no
 * pisa ningún redirect. Lo que estas pruebas sostienen es que la interfaz lo
 * DIGA — y no que se arregló, porque no se arregló: es una limitación del
 * proveedor y está afuera de este código.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const TARJETA = readFileSync(join(__dirname, '..', 'src', 'react', 'login-card.tsx'), 'utf8');

const login = (app: string) =>
  readFileSync(join(RAIZ, 'apps', app, 'app', 'login', 'page.tsx'), 'utf8');

describe('acceso al panel de plataforma (#113)', () => {
  it('el panel dice que se entra con el código, no con el enlace', () => {
    expect(login('admin')).toContain('recibeLosRedirects={false}');
  });

  it('la app de clientes no hereda esa restricción', () => {
    // Vive en el `site_url`: ahí el enlace y Google funcionan, y quitarlos
    // sería cobrarle a todos los negocios el problema del panel.
    const web = login('web');
    expect(web).not.toContain('recibeLosRedirects');
  });

  it('la tarjeta ofrece las dos instrucciones, no una sola para todos', () => {
    // Un texto fijo es lo que había: decía "abre el enlace" también donde el
    // enlace lleva a otra aplicación.
    expect(TARJETA).toContain('Abre el enlace desde este mismo dispositivo');
    expect(TARJETA).toContain('Acá se entra con el código, no con el enlace');
  });

  it('el botón de Google y la instrucción del enlace cuelgan de la MISMA pregunta', () => {
    // Eran dos decisiones sueltas con una sola causa. Separadas, apagar una y
    // olvidar la otra deja al operador exactamente igual de perdido.
    const usos = [...TARJETA.matchAll(/recibeLosRedirects/g)].length;
    expect(usos, 'la prop tiene que gobernar los dos caminos').toBeGreaterThanOrEqual(4);
    expect(TARJETA).toContain('{recibeLosRedirects && (');
  });

  it('el código de 6 dígitos entra por verifyOtp, que no depende de redirects', () => {
    // Es el camino que sostiene todo lo demás: si alguien lo cambiara por un
    // enlace, el panel se quedaría sin forma de entrar.
    expect(TARJETA).toContain('supabase.auth.verifyOtp(');
    expect(TARJETA).toContain("type: 'email'");
  });
});
