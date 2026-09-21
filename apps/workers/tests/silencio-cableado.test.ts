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
  it('las automatizaciones solicitan salida iniciada por el negocio', () => {
    const engine = fuente('../../packages/modules/automations/application/engine.ts');
    expect(engine).toContain("delivery: 'business'");
  });

  it('lo transaccional se salta el silencio y NADA más (ADR-0016)', () => {
    const outbound = fuente('src', 'outbound.ts');
    const bloque = outbound.slice(outbound.indexOf('if (data.initiatedByBusiness)'));
    const hastaElCierre = bloque.slice(0, bloque.indexOf('const account'));

    // La pausa por calidad va ANTES de la exención: si Meta tiene el número
    // castigado, mandar más lo empeora. Se pierde el comprobante, no el
    // número. Si alguien moviera el `if (!data.transaccional)` hacia arriba
    // para "simplificar", esto se cae.
    const posPausa = hastaElCierre.indexOf('isBusinessPaused');
    const posExencion = hastaElCierre.indexOf('!data.transaccional');
    expect(posPausa).toBeGreaterThan(0);
    expect(posExencion).toBeGreaterThan(posPausa);
  });

  it('solo el comprobante de pago es transaccional', () => {
    const comprobante = fuente('../../packages/modules/payments/application/confirm.ts');
    expect(comprobante).toContain("delivery: 'transactional'");
    const engine = fuente('../../packages/modules/automations/application/engine.ts');
    expect(engine).not.toContain("delivery: 'transactional'");
  });

  it('la respuesta de una persona en la bandeja NO lo está', () => {
    // El silencio protege al cliente de NOSOTROS, no de que le contesten.
    const controller = readFileSync(
      join(__dirname, '../../../apps/api/src/conversations.controller.ts'),
      'utf8',
    );
    expect(controller).toContain("delivery: 'reply'");
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
