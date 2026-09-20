import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Una campaña no sale sin haber mirado a quién le llega.
 *
 * El módulo ya trae la protección importante —la vista previa sale de la
 * MISMA consulta que después elige a los destinatarios— pero esa garantía
 * se pierde si la pantalla deja mandar sin mirar, o si deja mirar un
 * segmento y mandar otro.
 *
 * Como el de `simulador-no-va-a-produccion`, esto no cuida el tipo sino la
 * INTENCIÓN: la condición se puede borrar y todo sigue compilando y
 * pasando. Es la función que más rápido puede arruinarle la reputación a un
 * negocio; vale un test feo.
 */
const fuente = readFileSync(join(__dirname, '..', 'components', 'campanas.tsx'), 'utf8');

describe('la campaña no sale sin vista previa', () => {
  it('el primario exige haberla visto', () => {
    // `previa` es null hasta que el servidor contesta el conteo.
    expect(fuente).toMatch(/const listaParaEnviar = Boolean\(\s*previa &&/);
    expect(fuente).toMatch(/type="submit"[\s\S]{0,120}disabled=\{!listaParaEnviar/);
  });

  it('y la función de envío vuelve a comprobarlo, no solo el botón', () => {
    // Un botón deshabilitado es una cortesía, no una cerradura.
    const bloque = fuente.slice(fuente.indexOf('async function crearYEnviar'), fuente.indexOf('async function verResultados'));
    expect(bloque).toMatch(/if \([^)]*!previa\)\s*return/);
  });

  it('cambiar el segmento invalida lo que ya se vio', () => {
    // Sin esto se mira un segmento y se manda otro, que es exactamente el
    // agujero que la vista previa existe para tapar.
    expect(fuente).toMatch(/useEffect\(\(\) => \{\s*setPrevia\(null\);\s*\}, \[filtros\]\)/);
  });

  it('se previsualiza y se manda con el MISMO objeto de filtros', () => {
    const previa = fuente.slice(fuente.indexOf('async function verAQuienLeLlega'), fuente.indexOf('async function crearYEnviar'));
    const envio = fuente.slice(fuente.indexOf('async function crearYEnviar'), fuente.indexOf('async function verResultados'));
    expect(previa).toContain('JSON.stringify({ filtros })');
    expect(envio).toContain('filtros');
    // Nada de rearmar los filtros a mano en el envío.
    expect(envio).not.toMatch(/tagIds:\s*form\.tagIds/);
  });

  it('con el número en rojo el primario queda cerrado, y dice por qué', () => {
    expect(fuente).toMatch(/const enRojo = calidad === 'red'/);
    expect(fuente).toMatch(/listaParaEnviar = Boolean\([\s\S]{0,160}!enRojo/);
    expect(fuente).toContain('Con el número en rojo no se puede enviar');
  });

  it('los saltados se muestran con su motivo, no como un número suelto', () => {
    // "enviados: 120 de 200" sin decir qué pasó con los 80 obliga a
    // adivinar, y lo que se adivina es siempre lo más cómodo.
    expect(fuente).toContain('Por qué no le llegó a todos');
    expect(fuente).toMatch(/resultados\.motivos\.map/);
  });

  it('no usa hex suelto ni emoji (Pulso)', () => {
    expect(fuente).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(fuente).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
