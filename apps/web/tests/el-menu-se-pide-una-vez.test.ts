import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El menú se pide una vez y se cachea (#400).
 *
 * Estaba copiado en 26 páginas, todas con `cache: 'no-store'`. Esas llamadas
 * salen del servidor del web SIN `x-tenant-id`, así que el limitador cae a
 * su último recurso —el cupo por IP— y las 26 comparten uno solo de 120 por
 * minuto:
 *
 *   const subject = apiKey ? `key:…` : tenant ? `tenant:…` : `ip:${ip}`;
 *
 * Next además precarga los enlaces del menú al pasar el cursor, y cada
 * precarga renderiza la página en el servidor: una llamada más cada vez.
 * Con la barra lateral de #295 hay más enlaces a la vista, así que se
 * agotaba en segundos y el producto respondía "Demasiadas solicitudes
 * seguidas" a un usuario que solo estaba navegando.
 *
 * Lo que devuelve cambia cuando se despliega, no entre dos clics.
 */
const APP = join(__dirname, '..', 'app');
const NAV = join(__dirname, '..', 'lib', 'nav.ts');

function paginas(dir = APP, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) paginas(ruta, acc);
    else if (entrada === 'page.tsx') acc.push(ruta);
  }
  return acc;
}

describe('el menú se pide una vez y se cachea', () => {
  const archivos = paginas();

  it('hay páginas que mirar', () => {
    expect(archivos.length).toBeGreaterThan(20);
  });

  it('ninguna página se arma su propia llamada al menú', () => {
    const propias = archivos
      .filter((a) => readFileSync(a, 'utf8').includes('/v1/me/modules'))
      .map((a) => a.slice(APP.length + 1));
    expect(
      propias,
      'Estas páginas piden el menú por su cuenta en vez de usar `navDesdeLaApi`:\n  ' +
        propias.join('\n  ') +
        '\nCopiado en cada página, se vuelve a olvidar la caché en la siguiente.',
    ).toEqual([]);
  });

  it('y ninguna lo pide sin caché', () => {
    const sinCache = archivos
      .filter((a) => /no-store/.test(readFileSync(a, 'utf8')))
      .map((a) => a.slice(APP.length + 1));
    expect(sinCache, `páginas con 'no-store': ${sinCache.join(', ')}`).toEqual([]);
  });

  it('el helper compartido sí cachea, y no para siempre', () => {
    // Sin comentarios: `no-store` aparece en el que explica por qué NO se
    // usa, y la primera versión de este test se puso roja por eso.
    const nav = readFileSync(NAV, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(nav).toMatch(/next:\s*\{\s*revalidate:\s*\d+/);
    expect(nav).not.toContain("'no-store'");
    // Cachear para siempre sería peor que no cachear: un módulo recién
    // encendido no aparecería nunca en el menú.
    const segundos = Number(/revalidate:\s*(\d+)/.exec(nav)?.[1]);
    expect(segundos).toBeGreaterThan(0);
    expect(segundos).toBeLessThanOrEqual(300);
  });

  it('si la API no responde, el menú degrada en vez de romper la página', () => {
    expect(readFileSync(NAV, 'utf8')).toMatch(/catch\s*\{[\s\S]*?return \[\];/);
  });
});
