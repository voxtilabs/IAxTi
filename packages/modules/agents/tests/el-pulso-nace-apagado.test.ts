import { describe, expect, it } from 'vitest';
import { configDelPulso, tocaPulso, agenteConPulso, type PulsoConfig } from '../application/pulso';
import type { Agent } from '../application/agents';

/**
 * El pulso del evento (#1210): lo que decide a quién se le escribe sin que
 * haya preguntado nada.
 *
 * Es la función del producto que más rápido puede costar un número de
 * WhatsApp, así que estas pruebas cuidan dos cosas distintas: que no se
 * prenda sola, y que cuando no manda diga POR QUÉ no mandó. Lo segundo no es
 * cosmético: «no mandó» puede ser la ventana, la hora, el ritmo o el tope, y
 * los cuatro se arreglan distinto.
 *
 * Las horas se construyen con `new Date(a, m, d, hh, mm)` —hora local— a
 * propósito: `inAutonomousHours` compara contra el reloj local, y armarlas
 * desde un ISO en UTC haría que la prueba pasara o fallara según la zona de
 * la máquina.
 */

const CFG: PulsoConfig = { cadaMinutos: 40, desde: '08:30', hasta: '18:00', maxPorPersona: 6 };
/** Miércoles 4 de noviembre de 2026, 10:00 — dentro del horario. */
const EN_HORARIO = new Date(2026, 10, 4, 10, 0);
const hace = (minutos: number) => new Date(EN_HORARIO.getTime() - minutos * 60_000);

describe('el pulso nace apagado (#1210)', () => {
  it('sin `pulso` en los límites no hay pulso', () => {
    expect(configDelPulso({})).toBeNull();
    expect(configDelPulso({ max_agent_turns: 60 })).toBeNull();
  });

  /**
   * `activo !== true`, no `activo` a secas, y esta prueba es la razón.
   *
   * Un `{}` heredado, un `pulso: {}` a medio configurar o un `activo: 'no'`
   * —que en JavaScript es verdadero— no pueden ponerse a escribirle a la
   * cartera de nadie. Prender esto es una decisión que alguien toma, no un
   * valor por defecto al que se llega por descuido.
   */
  it('solo el booleano `true` lo prende: ni "si", ni 1, ni un objeto vacío', () => {
    expect(configDelPulso({ pulso: {} })).toBeNull();
    expect(configDelPulso({ pulso: { activo: 'si', desde: '08:30', hasta: '18:00' } })).toBeNull();
    expect(configDelPulso({ pulso: { activo: 1, desde: '08:30', hasta: '18:00' } })).toBeNull();
    expect(configDelPulso({ pulso: { activo: 'true', desde: '08:30', hasta: '18:00' } })).toBeNull();
    expect(configDelPulso({ pulso: { activo: true, desde: '08:30', hasta: '18:00' } })).not.toBeNull();
  });

  /**
   * Sin horario escrito, nada — por lo mismo que `inAutonomousHours` devuelve
   * false sin horario: un pulso sin hora de inicio y de término le escribiría
   * a las tres de la mañana, y el horario de silencio del producto está para
   * que eso no pase.
   */
  it('prendido pero sin horario escrito tampoco manda', () => {
    expect(configDelPulso({ pulso: { activo: true } })).toBeNull();
    expect(configDelPulso({ pulso: { activo: true, desde: '08:30' } })).toBeNull();
    expect(configDelPulso({ pulso: { activo: true, hasta: '18:00' } })).toBeNull();
  });

  it('el ritmo y el tope tienen defecto; el horario no', () => {
    const cfg = configDelPulso({ pulso: { activo: true, desde: '08:30', hasta: '18:00' } });
    expect(cfg).toEqual({ cadaMinutos: 40, desde: '08:30', hasta: '18:00', maxPorPersona: 6 });
  });

  it('un ritmo o un tope en cero o negativo caen al defecto, no a mandar siempre', () => {
    const cero = configDelPulso({
      pulso: { activo: true, desde: '08:30', hasta: '18:00', cada_minutos: 0, max_por_persona: 0 },
    });
    expect(cero).toEqual({ cadaMinutos: 40, desde: '08:30', hasta: '18:00', maxPorPersona: 6 });
  });

  it('el agente con el pulso prendido es el que se elige, y uno inactivo no cuenta', () => {
    const base = { limits: {}, active: true } as unknown as Agent;
    const apagado = { ...base, id: 'a' } as Agent;
    const prendido = {
      ...base,
      id: 'b',
      limits: { pulso: { activo: true, desde: '08:30', hasta: '18:00' } },
    } as Agent;
    expect(agenteConPulso([apagado])).toBeNull();
    expect(agenteConPulso([apagado, prendido])?.agent.id).toBe('b');
    expect(agenteConPulso([{ ...prendido, active: false }])).toBeNull();
  });
});

describe('cuando el pulso no manda, dice por qué (#1210)', () => {
  const caso = (extra: Partial<Parameters<typeof tocaPulso>[0]>) =>
    tocaPulso({
      ahora: EN_HORARIO,
      cfg: CFG,
      canal: 'whatsapp',
      ultimoEntrante: hace(60),
      ultimoSaliente: hace(45),
      pulsosEnviados: 0,
      ...extra,
    });

  it('manda cuando pasó el rato, hay ventana y queda tope', () => {
    expect(caso({})).toEqual({ manda: true, motivo: 'manda' });
  });

  it('sin configuración: apagado', () => {
    expect(caso({ cfg: null })).toEqual({ manda: false, motivo: 'apagado' });
  });

  it('a quien nunca escribió no se le escribe, y el motivo lo dice', () => {
    expect(caso({ ultimoEntrante: null })).toEqual({ manda: false, motivo: 'sin_entrante' });
  });

  /**
   * La ventana se mira ANTES que la hora y que el ritmo, y por eso hay prueba:
   * fuera de la ventana el proveedor no entrega nada sin plantilla aprobada.
   * Si el motivo saliera 'muy_pronto', alguien bajaría `cada_minutos` para
   * arreglarlo y seguiría sin salir nada.
   */
  it('con la ventana de 24 h cerrada el motivo es la ventana, no el ritmo', () => {
    // Fallan DOS cosas a la vez —la ventana Y el ritmo— y se comprueba cuál
    // gana. Con una sola fallando, el motivo saldría igual con la ventana
    // mirada al principio o al final, y la prueba no diría nada del orden:
    // lo verifiqué moviendo la comprobación al final y quedó verde.
    const r = caso({ ultimoEntrante: new Date(2026, 10, 1, 10, 0), ultimoSaliente: hace(10) });
    expect(r).toEqual({ manda: false, motivo: 'ventana_cerrada' });
  });

  it('fuera del horario no manda, y en horario sí — el mismo caso, dos instantes', () => {
    const temprano = caso({ ahora: new Date(2026, 10, 4, 7, 0), ultimoEntrante: new Date(2026, 10, 4, 6, 0), ultimoSaliente: null });
    expect(temprano).toEqual({ manda: false, motivo: 'fuera_de_horario' });
    const tarde = caso({ ahora: new Date(2026, 10, 4, 19, 0), ultimoEntrante: new Date(2026, 10, 4, 18, 0), ultimoSaliente: null });
    expect(tarde).toEqual({ manda: false, motivo: 'fuera_de_horario' });
    expect(caso({}).manda).toBe(true);
  });

  it('el tope por persona corta antes de mirar el ritmo', () => {
    // Igual que arriba: el tope alcanzado Y el rato sin cumplir, para que el
    // motivo diga de verdad cuál se mira primero. El tope va antes porque es
    // definitivo —de hoy esta persona no recibe más— y el ritmo es «todavía
    // no»: quien lee el log tiene que ver el que no se va a resolver solo.
    expect(caso({ pulsosEnviados: 6, ultimoSaliente: hace(10) })).toEqual({
      manda: false,
      motivo: 'tope_alcanzado',
    });
    expect(caso({ pulsosEnviados: 7 })).toEqual({ manda: false, motivo: 'tope_alcanzado' });
    expect(caso({ pulsosEnviados: 5 }).manda).toBe(true);
  });

  it('el ritmo se cuenta desde el último saliente', () => {
    expect(caso({ ultimoSaliente: hace(39) })).toEqual({ manda: false, motivo: 'muy_pronto' });
    expect(caso({ ultimoSaliente: hace(40) }).manda).toBe(true);
  });

  /**
   * Sin saliente, el reloj arranca en el ENTRANTE y no en cero.
   *
   * Si arrancara en cero, a quien acaba de escribir —y que por lo tanto está
   * esperando una respuesta, no un pulso— le llegaría el pulso en el mismo
   * minuto, pisando la respuesta que el copiloto está generando.
   */
  it('sin saliente todavía, el ritmo se cuenta desde que la persona escribió', () => {
    expect(caso({ ultimoSaliente: null, ultimoEntrante: hace(5) })).toEqual({
      manda: false,
      motivo: 'muy_pronto',
    });
    expect(caso({ ultimoSaliente: null, ultimoEntrante: hace(41) }).manda).toBe(true);
  });
});
