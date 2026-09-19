import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El simulador de mensajes NO se ofrece en producción.
 *
 * `POST /v1/dev/inbound` solo se registra fuera de producción: allá la ruta
 * ni siquiera devuelve 403, no existe. Así que el botón sería un 404 con
 * forma de función.
 *
 * Este test no cuida el tipo —eso lo hace el compilador— sino la INTENCIÓN,
 * que es lo que un refactor distraído puede invertir sin que nada falle: la
 * condición se puede borrar y todo sigue compilando y pasando.
 */
const fuente = readFileSync(join(__dirname, '..', 'components', 'canales.tsx'), 'utf8');

describe('probar sin número real', () => {
  it('no se dibuja en producción', () => {
    // La condición, y que sea una salida temprana: comprobarlo y dibujar
    // igual sería peor que no comprobarlo, porque parece cuidado.
    expect(fuente).toMatch(/config\.env === 'production'\)\s*return null/);
  });

  it('pega a /dev/inbound y no a otra cosa', () => {
    // Si alguien lo apunta a un envío real, el panel deja de ser una
    // simulación y le escribe a un cliente de verdad.
    const bloque = fuente.slice(fuente.indexOf('function ProbarSinNumero'), fuente.indexOf('export function Canales'));
    expect(bloque).toContain("'/dev/inbound'");
    expect(bloque).not.toMatch(/\/conversations\/[^/]*\/messages/);
  });

  it('se monta dentro de Canales, no dentro de sí mismo', () => {
    // Me pasó al escribirlo: lo inserté dentro de su propio render y era
    // recursión infinita. Compila igual.
    const propio = fuente.slice(fuente.indexOf('function ProbarSinNumero'), fuente.indexOf('export function Canales'));
    expect(propio).not.toContain('<ProbarSinNumero />');
    expect(fuente.slice(fuente.indexOf('export function Canales'))).toContain('<ProbarSinNumero />');
  });
});
