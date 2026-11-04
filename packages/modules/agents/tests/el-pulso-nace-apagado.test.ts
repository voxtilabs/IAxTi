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
/**
 * Miércoles 4 de noviembre de 2026, 12:00 EN CHILE — dentro del horario.
 *
 * Instante explícito en UTC y no `new Date(2026, 10, 4, 10, 0)`, que es hora
 * local: la primera versión usaba eso «para no depender de la zona» y era
 * justo al revés —dependía de la de la máquina—. En CI, que corre en UTC,
 * esas 10:00 eran 07:00 de Chile y el pulso caía fuera de horario (#1225).
 */
const EN_HORARIO = new Date('2026-11-04T15:00:00Z');
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
    // 07:00 y 06:00 de Chile: antes de que abra.
    const temprano = caso({ ahora: new Date('2026-11-04T10:00:00Z'), ultimoEntrante: new Date('2026-11-04T09:00:00Z'), ultimoSaliente: null });
    expect(temprano).toEqual({ manda: false, motivo: 'fuera_de_horario' });
    // 19:00 y 18:00 de Chile: ya cerró.
    const tarde = caso({ ahora: new Date('2026-11-04T22:00:00Z'), ultimoEntrante: new Date('2026-11-04T21:00:00Z'), ultimoSaliente: null });
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

/**
 * El horario del pulso se lee en la hora del NEGOCIO (#1225).
 *
 * Antes se comparaba con el reloj del proceso. Para cubrir 08:30–18:00 del
 * Tech AI Summit hubo que configurarle 11:30–21:00 —mentirle a la
 * configuración para que hiciera lo correcto—, y cualquiera que mirara esos
 * números después no habría entendido nada.
 */
describe('el horario del pulso es el del negocio (#1225)', () => {
  /** 2026-11-03 12:00 UTC = 09:00 en Chile. */
  const nueveEnChile = new Date('2026-11-03T12:00:00.000Z');
  const base = {
    ahora: nueveEnChile,
    cfg: { cadaMinutos: 40, desde: '08:30', hasta: '18:00', maxPorPersona: 6 } as PulsoConfig,
    canal: 'whatsapp',
    ultimoEntrante: new Date('2026-11-03T11:00:00.000Z'),
    ultimoSaliente: new Date('2026-11-03T11:00:00.000Z'),
    pulsosEnviados: 0,
  };

  it('a las 09:00 de Chile manda, aunque en UTC sean las 12:00', () => {
    expect(tocaPulso({ ...base, zona: 'America/Santiago' })).toEqual({ manda: true, motivo: 'manda' });
  });

  /**
   * El MISMO instante y la MISMA configuración, juzgados con el reloj del
   * contenedor: 12:00 sigue dentro de 08:30–18:00, así que esto solo no
   * discrimina. El caso que discrimina es el de abajo.
   */
  it('y el mismo instante en UTC también cae dentro: por eso hace falta el de abajo', () => {
    expect(tocaPulso({ ...base, zona: 'UTC' }).manda).toBe(true);
  });

  it('a las 17:00 de Chile manda y con el reloj del contenedor ya NO', () => {
    // 2026-11-03 20:00 UTC = 17:00 en Chile, dentro de 08:30–18:00.
    const cincoDeLaTarde = new Date('2026-11-03T20:00:00.000Z');
    const caso = {
      ...base,
      ahora: cincoDeLaTarde,
      ultimoEntrante: new Date('2026-11-03T19:00:00.000Z'),
      ultimoSaliente: new Date('2026-11-03T19:00:00.000Z'),
    };
    expect(tocaPulso({ ...caso, zona: 'America/Santiago' })).toEqual({ manda: true, motivo: 'manda' });
    // Con la zona del proceso, a esa misma hora el pulso ya se apagó: son las
    // 20:00 «suyas». Eso es lo que pasaba en staging, y es lo que obligaba a
    // escribirle el horario corrido.
    expect(tocaPulso({ ...caso, zona: 'UTC' })).toEqual({ manda: false, motivo: 'fuera_de_horario' });
  });

  it('sin zona usa la del producto, que es la de Chile', () => {
    const sinZona = tocaPulso({ ...base });
    expect(sinZona).toEqual(tocaPulso({ ...base, zona: 'America/Santiago' }));
  });
});

/**
 * La ventana se mide con el instante que se recibe (#1256).
 *
 * `tocaPulso` promete decidir sobre `ahora`, y la comprobación de la ventana
 * de 24 h se saltaba ese parámetro: `isWithinWindow` lo tiene con un defecto
 * —el reloj de la máquina— y no se lo pasábamos. En producción los dos
 * coincidían, así que el defecto era invisible; lo que lo destapó fue que la
 * prueba de #1225, con su fecha fija, caducara sola a las 24 h y dejara la
 * suite de `staging` entera roja.
 *
 * Estos casos usan un instante MUY lejano a propósito. Una prueba que dependa
 * de qué día es hoy no es una prueba: es una cuenta regresiva.
 */
describe('la ventana se mide con el instante recibido, no con el reloj (#1256)', () => {
  const lejos = new Date('2030-06-12T14:00:00.000Z'); // 10:00 en Chile
  const cfg: PulsoConfig = { cadaMinutos: 40, desde: '08:30', hasta: '18:00', maxPorPersona: 6 };

  it('entrante una hora antes de ESE instante: la ventana está abierta', () => {
    expect(
      tocaPulso({
        ahora: lejos,
        cfg,
        canal: 'whatsapp',
        ultimoEntrante: new Date('2030-06-12T13:00:00.000Z'),
        ultimoSaliente: new Date('2030-06-12T13:00:00.000Z'),
        pulsosEnviados: 0,
        zona: 'America/Santiago',
      }),
    ).toEqual({ manda: true, motivo: 'manda' });
  });

  /**
   * El otro lado de la misma moneda: 25 h ANTES de ese instante sí cierra.
   * Con los dos casos, un `tocaPulso` que ignorara `ahora` falla en uno o en
   * el otro siempre, sea cual sea la fecha en que se corra.
   */
  it('entrante 25 h antes de ESE instante: la ventana está cerrada', () => {
    expect(
      tocaPulso({
        ahora: lejos,
        cfg,
        canal: 'whatsapp',
        ultimoEntrante: new Date('2030-06-11T13:00:00.000Z'),
        ultimoSaliente: new Date('2030-06-11T13:00:00.000Z'),
        pulsosEnviados: 0,
        zona: 'America/Santiago',
      }),
    ).toEqual({ manda: false, motivo: 'ventana_cerrada' });
  });
});
