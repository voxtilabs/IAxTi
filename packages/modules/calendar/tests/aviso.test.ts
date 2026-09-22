import { describe, expect, it } from 'vitest';
import { configuracionDeAvisos, cuandoEnPalabras, valoresDelAviso } from '../domain/aviso';

/**
 * Con qué plantilla sale cada recordatorio, y qué dice (#59).
 *
 * Lo que se cuida acá es que un negocio a medio configurar NO active el
 * barrido: marcar una cita `reminded` sin mandar nada la deja para siempre
 * en un estado que una persona lee como "al cliente ya se le avisó".
 */
describe('la configuración de los avisos', () => {
  it('sin nada configurado, el recordatorio no está activo', () => {
    for (const settings of [null, undefined, {}, { calendar: {} }, { calendar: { recordatorios: {} } }]) {
      expect(configuracionDeAvisos(settings).activo, JSON.stringify(settings)).toBe(false);
    }
  });

  it('con UNA sola plantilla ya está activo: muchos quieren solo el de 2 h', () => {
    const cfg = configuracionDeAvisos({ calendar: { recordatorios: { '2h': 'tpl-2h' } } });
    expect(cfg.activo).toBe(true);
    expect(cfg.plantillas['2h']).toBe('tpl-2h');
    expect(cfg.plantillas['24h']).toBeNull();
  });

  it('una plantilla en blanco es lo mismo que ninguna', () => {
    // Un campo vaciado en la pantalla llega como cadena vacía, y un
    // templateId vacío buscado en la base no encuentra nada: el barrido
    // marcaría la cita y no mandaría el aviso.
    const cfg = configuracionDeAvisos({ calendar: { recordatorios: { '24h': '   ', '2h': 42 } } });
    expect(cfg.activo).toBe(false);
    expect(cfg.plantillas['24h']).toBeNull();
    expect(cfg.plantillas['2h']).toBeNull();
  });

  it('la zona por defecto es la de Chile, y se puede cambiar', () => {
    expect(configuracionDeAvisos({}).zona).toBe('America/Santiago');
    expect(configuracionDeAvisos({ calendar: { zona: 'America/Lima' } }).zona).toBe('America/Lima');
  });
});

describe('qué dice el recordatorio', () => {
  it('la hora va en la zona del negocio, no en UTC', () => {
    // Una cita dicha en UTC llega tres horas corrida y el cliente se
    // presenta cuando no es. Es el error más caro de todo esto.
    const cita = new Date('2026-09-23T18:30:00Z'); // 15:30 en Santiago
    expect(cuandoEnPalabras(cita, 'America/Santiago')).toContain('15:30');
    expect(cuandoEnPalabras(cita, 'America/Santiago')).toContain('23');
    expect(cuandoEnPalabras(cita, 'UTC')).toContain('18:30');
  });

  it('los valores van en el orden del contrato: nombre y cuándo', () => {
    const valores = valoresDelAviso({
      nombre: 'Ana',
      cuando: new Date('2026-09-23T18:30:00Z'),
      zona: 'America/Santiago',
      variables: 2,
    });
    expect(valores[0]).toBe('Ana');
    expect(valores[1]).toContain('15:30');
  });

  it('se recortan a las variables que la plantilla pide', () => {
    // Una plantilla aprobada por Meta con una sola variable rechaza el
    // envío si le mandan dos, y no se puede corregir: se crea otra y se
    // espera la aprobación de nuevo.
    expect(valoresDelAviso({ nombre: 'Ana', cuando: new Date(), variables: 1 })).toEqual(['Ana']);
    expect(valoresDelAviso({ nombre: 'Ana', cuando: new Date(), variables: 0 })).toEqual([]);
  });

  it('sin nombre no queda un hueco en el mensaje', () => {
    // "Hola , te recordamos" se ve como un error del negocio.
    const [saludo] = valoresDelAviso({ nombre: null, cuando: new Date(), variables: 2 });
    expect(saludo.trim().length).toBeGreaterThan(0);
  });
});
