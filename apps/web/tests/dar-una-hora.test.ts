import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dar una hora desde la agenda (#460).
 *
 * `GET /agenda/huecos` y `POST /agenda` existen desde #57 y las usaba solo
 * el asistente, por sus herramientas. Quien atiende por teléfono no tenía
 * dónde: la agenda mostraba las horas dadas y ninguna forma de dar una.
 */
const DAR = readFileSync(join(__dirname, '..', 'components', 'dar-una-hora.tsx'), 'utf8');
const AGENDA = readFileSync(join(__dirname, '..', 'components', 'agenda.tsx'), 'utf8');

describe('dar una hora', () => {
  it('los huecos salen del servidor, no de una grilla dibujada acá', () => {
    // Ya descuentan lo agendado, el respiro entre citas y la anticipación
    // mínima: una grilla propia ofrecería horas que la API va a rechazar.
    expect(DAR).toContain('`/agenda/huecos?dia=${dia}`');
  });

  it('agenda con el inicio y el fin del hueco elegido', () => {
    expect(DAR).toContain('contactId: elegido.id, inicio: h.inicio, fin: h.fin');
  });

  it('no deja elegir una hora sin saber para quién', () => {
    expect(DAR).toContain('disabled={!elegido');
  });

  it('si la hora se tomó entre medio, se vuelven a pedir los huecos', () => {
    const bloque = DAR.slice(DAR.indexOf('async function agendar'));
    const captura = bloque.slice(bloque.indexOf('} catch (err) {'));
    expect(captura.slice(0, 400)).toContain('await cargarHuecos();');
  });

  it('sin huecos apunta a los horarios, que es la causa más común', () => {
    expect(DAR).toContain('Revisa los horarios en que atiendes');
  });

  it('vive con las citas, no con la configuración', () => {
    // Los dos índices se comprueban ANTES de compararlos (#838). `indexOf`
    // devuelve -1 cuando no encuentra, y -1 es menor que cualquier índice
    // válido: si `<DarUnaHora` saliera de la agenda, la comparación pasaba
    // igual. Y ésta es la ÚNICA mención del componente en todo
    // `apps/web/tests`, así que nada más lo echaría de menos — justo el
    // defecto que este archivo vino a cerrar («`POST /agenda` existía desde
    // #57 y no la usaba ninguna pantalla»).
    const iDarUnaHora = AGENDA.indexOf('<DarUnaHora');
    const iHorarios = AGENDA.indexOf('<HorariosDeAtencion />');
    expect(iDarUnaHora, '`<DarUnaHora` no está en la agenda').toBeGreaterThan(-1);
    expect(iHorarios, '`<HorariosDeAtencion />` no está en la agenda').toBeGreaterThan(-1);
    expect(iDarUnaHora).toBeLessThan(iHorarios);
  });
});
