import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El cableado del horario de silencio (SPEC §8).
 *
 * La compuerta vive en el worker y depende de `initiatedByBusiness`. El
 * motor de automatizaciones documentaba "la cola outbound aplica el
 * silencio" y devolvía "mensaje en cola (respeta silencio y consentimiento)"
 * — pero el cableado encolaba SIN la bandera, así que la compuerta nunca se
 * activaba: una automatización de las 3am salía a las 3am. Y de paso se
 * saltaba la pausa por calidad, que vive en el mismo bloque.
 *
 * El tipo ahora obliga a declararlo en cada sitio, así que este test no
 * cuida el tipo: cuida la INTENCIÓN de cada camino, que es lo que un
 * refactor distraído puede invertir sin que nada falle.
 */
function fuente(...partes: string[]): string {
  return readFileSync(join(__dirname, '..', ...partes), 'utf8');
}

describe('quién respeta el horario de silencio', () => {
  it('automatizaciones y secuencias van marcadas como del negocio', () => {
    const main = fuente('src', 'main.ts');
    // La ASIGNACIÓN, no la primera mención: hay un comentario antes que
    // habla de ella (me lo encontré escribiendo este test).
    const i = main.indexOf('automationDeps.enqueueOutbound =');
    expect(i, 'no encontré el cableado de enqueueOutbound').toBeGreaterThan(0);
    expect(main.slice(i, i + 700)).toContain('initiatedByBusiness: true');
  });

  it('la respuesta de una persona en la bandeja NO lo está', () => {
    // El silencio protege al cliente de NOSOTROS, no de que le contesten.
    const controller = readFileSync(
      join(__dirname, '../../../apps/api/src/conversations.controller.ts'),
      'utf8',
    );
    expect(controller).toContain('initiatedByBusiness: false');
  });

  it('el worker solo aplica silencio y pausa de calidad a lo del negocio', () => {
    const outbound = fuente('src', 'outbound.ts');
    const bloque = outbound.slice(outbound.indexOf('if (data.initiatedByBusiness)'));
    const hastaElCierre = bloque.slice(0, bloque.indexOf('const account'));
    // Las dos protecciones viven juntas: quien se salta una se salta ambas.
    expect(hastaElCierre).toContain('isBusinessPaused');
    expect(hastaElCierre).toContain('enSilencio');
  });
});
