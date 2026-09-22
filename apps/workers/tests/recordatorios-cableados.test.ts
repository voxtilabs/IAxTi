import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El barrido de recordatorios, conectado de verdad (#59).
 *
 * Esto estuvo así desde que se escribió:
 *
 *     const res = await barrerRecordatorios(pool, {
 *       disponible: () => false,
 *       enviar: async () => ({ enviado: false, motivo: '…' }),
 *     });
 *
 * El módulo entero —las dos ventanas, `reminders_sent`, el evento, la marca
 * antes de enviar— existía y corría cada pocos minutos sin mandar nada. El
 * motivo del comentario era cierto el día que se escribió: faltaba la
 * plantilla aprobada y el número conectado. Las dos cosas llegaron y nadie
 * volvió acá.
 *
 * Por eso el test mira el CABLEADO y no el módulo: lo que falló nunca fue
 * la lógica, fue el sitio donde se conecta.
 */
const MAIN = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
const BLOQUE = MAIN.slice(
  MAIN.indexOf("case 'calendar.reminders'"),
  MAIN.indexOf("case 'api_usage.flush'"),
);

describe('el barrido de recordatorios', () => {
  it('no está apagado con una constante', () => {
    expect(BLOQUE.length).toBeGreaterThan(200);
    expect(BLOQUE).not.toMatch(/disponible:\s*\(\)\s*=>\s*false/);
    expect(BLOQUE).not.toMatch(/enviado:\s*false\s*,\s*motivo:\s*'falta la plantilla/);
  });

  it('manda la plantilla de verdad', () => {
    expect(BLOQUE).toContain('enviarPlantilla');
    expect(BLOQUE).toContain('valoresDelAviso');
  });

  it('el envío es iniciado por el negocio: la cola le aplica el silencio', () => {
    // A las dos horas de una cita de las 9 de la mañana son las 7. El
    // horario de silencio lo aplica la cola (SPEC §8) y solo lo aplica a lo
    // marcado `business`: sin esa marca, el recordatorio sale a las 7.
    expect(BLOQUE).toContain("delivery: 'business'");
  });

  it('pregunta si ESTE negocio puede antes de tocar sus citas', () => {
    // `disponible` responde por el ambiente. Sin la pregunta por tenant, el
    // negocio que todavía no eligió plantilla se lleva sus citas a
    // `reminded` —que se lee como "al cliente ya se le avisó"— sin que
    // salga nada.
    expect(BLOQUE).toContain('disponibleParaTenant');
  });

  it('respeta el consentimiento, como todo lo que sale hacia un cliente', () => {
    expect(BLOQUE).toContain('canReceiveBusinessInitiated');
  });

  it('una plantilla que dejó de estar aprobada no se manda', () => {
    // Meta puede bajar una plantilla aprobada. Mandarla igual es un rechazo
    // del proveedor y una cita marcada como avisada.
    expect(BLOQUE).toMatch(/status !== 'approved'/);
  });
});
