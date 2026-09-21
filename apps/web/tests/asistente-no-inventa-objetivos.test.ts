import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los objetivos que dibuja la pantalla salen del servidor.
 *
 * `DEFINICIONES` vive en `packages/modules/agents/domain/objetivo.ts` y es
 * la fuente: de ahí salen las herramientas que recibe el asistente, los
 * módulos que necesita y el evento con el que se mide. Una copia en el
 * frontend se desincroniza, y el síntoma sería que alguien elige un
 * objetivo que el servidor ya no acepta — o peor, que lo acepta y hace otra
 * cosa.
 *
 * Es el mismo criterio que con la navegación: el frontend jamás hardcodea
 * qué módulos existen.
 */
const PANTALLA = readFileSync(join(__dirname, '..', 'components', 'asistente.tsx'), 'utf8');
const DOMINIO = readFileSync(
  join(__dirname, '..', '..', '..', 'packages', 'modules', 'agents', 'domain', 'objetivo.ts'),
  'utf8',
);

const OBJETIVOS = [...(/export const OBJETIVOS = \[([^\]]*)\]/.exec(DOMINIO)?.[1] ?? '')
  .matchAll(/'([^']+)'/g)].map((m) => m[1]);

describe('la pantalla del asistente no inventa objetivos', () => {
  it('el dominio declara los objetivos que esperamos', () => {
    expect(OBJETIVOS.length).toBeGreaterThanOrEqual(3);
  });

  it('los pide al servidor', () => {
    expect(PANTALLA).toContain("'/agents/objetivos'");
  });

  it('no trae ninguno escrito a mano', () => {
    // Un `'agendar'` suelto en la pantalla es una copia esperando a
    // desincronizarse.
    const sueltos = OBJETIVOS.filter((o) => PANTALLA.includes(`'${o}'`));
    expect(
      sueltos,
      `Estos objetivos están escritos en la pantalla en vez de venir del catálogo: ${sueltos.join(', ')}`,
    ).toEqual([]);
  });

  it('un objetivo bloqueado se muestra, no se esconde', () => {
    // Bajar de plan nunca esconde (SPEC §6), y acá además es lo que le dice
    // al negocio qué le falta.
    expect(PANTALLA).toMatch(/disabled=\{!o\.disponible\}/);
    expect(PANTALLA).toContain('que tu plan');
    expect(PANTALLA).not.toMatch(/objetivos\s*\.filter\(\s*\(o\)\s*=>\s*o\.disponible/);
  });

  it('el asistente nace sugiriendo, no actuando solo', () => {
    // ADR-0010: el copiloto sugiere y el humano envía. La pantalla no manda
    // `defaultMode` al crear, así que toma el defecto del servidor
    // (`assist`), y se lo dice al dueño con todas sus letras.
    //
    // La afirmación va sobre el CUERPO de `crear` y no sobre el archivo
    // entero: `defaultMode` aparece legítimamente en el tipo de la
    // respuesta, y la primera versión de este test se puso roja por eso.
    const crear = PANTALLA.slice(PANTALLA.indexOf('async function crear'), PANTALLA.indexOf('if (agentes === null)'));
    expect(crear).toContain("'/agents'");
    expect(crear).not.toContain('defaultMode');
    expect(crear).not.toContain('provider');
    expect(PANTALLA).toContain('solo sugiriendo');
  });

  it('separa a quién le habla cada asistente (#410)', () => {
    // "Vender" y "Responder sobre los números" en la misma lista harían
    // elegir mal: no son alternativas, son asistentes distintos.
    expect(PANTALLA).toMatch(/destinatario === 'cliente'/);
    expect(PANTALLA).toMatch(/destinatario === 'dueño'/);
    expect(PANTALLA).toContain('Para contestarle a tus clientes');
    expect(PANTALLA).toContain('Para ayudarte a ti');
  });

  it('el grupo vacío no se dibuja', () => {
    // Si un negocio no tiene analytics, "Para ayudarte a ti" quedaría como
    // un encabezado sin nada debajo.
    expect(PANTALLA).toMatch(/\.filter\(\(g\) => g\.items\.length > 0\)/);
  });
});
