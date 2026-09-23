import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cuánto guarda el negocio sus conversaciones (#480).
 *
 * `PUT /settings/retencion` existe desde #77 y no la llamaba nadie: la
 * bandeja mostraba desde cuándo NO hay historial y el negocio no podía
 * decidir nada. El guard no lo veía porque el `GET` de la misma ruta sí
 * tiene consumidor — el aviso de la ficha.
 */
const RET = readFileSync(join(__dirname, '..', 'components', 'retencion-del-negocio.tsx'), 'utf8');
const PAGINA = readFileSync(join(__dirname, '..', 'app', 'ajustes', 'bandeja', 'page.tsx'), 'utf8');

describe('retención del negocio', () => {
  it('guarda contra la ruta que ya existía', () => {
    expect(RET).toContain("'/settings/retencion'");
    expect(RET).toContain("method: 'PUT'");
  });

  it('en blanco vuelve a lo del plan', () => {
    // Un override que solo se puede poner obliga a recordar de memoria el
    // número que traía el plan.
    expect(RET).toContain("valor.trim() === '' ? null : Number(valor)");
  });

  it('dice cuántas conversaciones se van a borrar, y cuándo', () => {
    // La purga se difiere 30 días a propósito: para que haya tiempo de
    // arrepentirse.
    expect(RET).toContain('purga.count');
    expect(RET).toContain('purga.firstPurgeAt');
  });

  it('no promete alargar más que el plan', () => {
    // Quien sabe qué plan tiene este negocio hoy es el servidor.
    expect(RET).toContain('nunca alargarlo por encima del plan');
  });

  it('va al final de la pantalla, no al principio', () => {
    // Es la decisión que BORRA: no conviene que sea la primera que se
    // encuentra.
    expect(PAGINA.indexOf('<RetencionDelNegocio />')).toBeGreaterThan(
      PAGINA.indexOf('<AtajosDeRespuesta />'),
    );
  });
});
