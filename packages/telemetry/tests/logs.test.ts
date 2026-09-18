import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activarLogsEstructurados,
  agregarAlContextoDeLog,
  conContextoDeLog,
  contextoDeLogActual,
} from '../src/index';

/**
 * Los logs con su tenant (#17).
 *
 * El criterio pedía `tenant_id` en los logs estructurados. Los mensajes
 * están escritos para que los lea una persona y siguen igual; lo que cambia
 * es el sobre, y solo con `LOG_FORMAT=json`.
 */
const originales = { log: console.log, warn: console.warn, error: console.error };
let salida: string[] = [];

beforeEach(() => {
  salida = [];
  process.env.LOG_FORMAT = 'json';
  // Se envuelve la consola de verdad, así que el espía va DEBAJO.
  console.log = (...a: unknown[]) => void salida.push(String(a[0]));
  console.warn = (...a: unknown[]) => void salida.push(String(a[0]));
  console.error = (...a: unknown[]) => void salida.push(String(a[0]));
  activarLogsEstructurados('test');
});

afterEach(() => {
  Object.assign(console, originales);
  delete process.env.LOG_FORMAT;
});

describe('el sobre de los logs', () => {
  it('el mensaje humano sigue entero, con el tenant al lado', () => {
    conContextoDeLog({ tenantId: 't-42', requestId: 'req_abc' }, () => {
      console.log('scheduled: 3 reglas y 2 pasos de secuencia');
    });
    const linea = JSON.parse(salida[0]);
    // El mensaje NO se toca: el que lo lee en Grafana lee lo mismo que en
    // la terminal.
    expect(linea.msg).toBe('scheduled: 3 reglas y 2 pasos de secuencia');
    expect(linea.tenant_id).toBe('t-42');
    expect(linea.request_id).toBe('req_abc');
    expect(linea.level).toBe('info');
    expect(linea.service).toBe('test');
  });

  it('sin contexto, la línea sale igual — sin campos inventados', () => {
    console.warn('workers: sin llaves VAPID; el push web queda apagado.');
    const linea = JSON.parse(salida[0]);
    expect(linea.level).toBe('warn');
    expect(linea.msg).toContain('VAPID');
    // Un `tenant_id: null` en cada línea de arranque es ruido que después
    // hay que filtrar.
    expect('tenant_id' in linea).toBe(false);
  });

  it('un error lleva su stack; una línea normal no lleva el campo vacío', () => {
    console.error('inbound: adjunto no descargado —', new Error('timeout'));
    const conError = JSON.parse(salida[0]);
    expect(conError.msg).toBe('inbound: adjunto no descargado — timeout');
    expect(conError.stack).toContain('Error: timeout');

    console.log('todo bien');
    expect('stack' in JSON.parse(salida[1])).toBe(false);
  });

  it('un objeto con ciclos no tumba el log', () => {
    const ciclo: Record<string, unknown> = { a: 1 };
    ciclo.yo = ciclo;
    expect(() => console.log('con ciclo', ciclo)).not.toThrow();
    expect(salida[0]).toContain('con ciclo');
  });
});

describe('el contexto', () => {
  it('lo de adentro hereda lo de afuera', () => {
    conContextoDeLog({ tenantId: 't-1' }, () => {
      conContextoDeLog({ requestId: 'r-1' }, () => {
        expect(contextoDeLogActual()).toEqual({ tenantId: 't-1', requestId: 'r-1' });
      });
      // Y lo de adentro no se le escapa a lo de afuera.
      expect(contextoDeLogActual().requestId).toBeUndefined();
    });
  });

  it('se puede completar a mitad de camino: el tenant se sabe después', () => {
    conContextoDeLog({ requestId: 'r-2' }, () => {
      // Así llega el request al middleware: con id y sin tenant.
      expect(contextoDeLogActual().tenantId).toBeUndefined();
      agregarAlContextoDeLog({ tenantId: 't-9' }); // el guard ya resolvió quién es
      console.log('contacto actualizado');
    });
    expect(JSON.parse(salida[0]).tenant_id).toBe('t-9');
  });

  it('agregar fuera de todo contexto no rompe nada', () => {
    expect(() => agregarAlContextoDeLog({ tenantId: 't-0' })).not.toThrow();
  });
});
