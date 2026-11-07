import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adrsCitadasSinPagina,
  adrsConNumeroRepetido,
  adrsQueExisten,
} from '../src/adr-citada-existe';

/**
 * Cada ADR que el código cita existe como página (#1292).
 *
 * Nace de un caso real y de los peores: `hilos-del-agente.ts` citaba
 * `ADR-0029` para justificar que los hilos del Agente General caducan a los 30
 * días, y ese ADR llevaba seis días en un PR abierto como *propuesta*. El
 * código daba por decidido algo que no estaba escrito.
 *
 * Y mientras esperaba, el 0029 se lo llevó otra decisión —el agente tomando la
 * hora—, así que las citas del hilo resolvían a una página que existía y
 * hablaba de otra cosa. Nadie vio un error: el puntero no estaba roto, estaba
 * apuntando mal, que es peor.
 *
 * Esto mide lo único medible —que el número tenga su página— y encima detecta
 * el otro lado: dos páginas con el mismo número.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const ADR = join(RAIZ, 'docs', 'adr');
const RAICES = [join(RAIZ, 'packages'), join(RAIZ, 'apps')];

describe('cada ADR citada tiene su página (#1292)', () => {
  it('ninguna cita del código apunta a una página que no existe', () => {
    expect(
      adrsCitadasSinPagina(RAICES, ADR).map((c) => `${c.adr} en ${c.donde}`),
      'El código cita decisiones que no están escritas. Si el ADR está en un PR sin\n' +
        'mergear, la cita promete algo que nadie puede leer: mergeá la página o\n' +
        'quitá la cita. Si el número cambió, actualizá la cita — un puntero que\n' +
        'resuelve a OTRO tema no da error en ninguna parte.',
    ).toEqual([]);
  });

  it('no hay dos páginas con el mismo número', () => {
    expect(
      adrsConNumeroRepetido(ADR),
      'Dos ADR con el mismo número hacen que toda cita a ese número sea ambigua.',
    ).toEqual([]);
  });

  it('el escáner encuentra algo: si esto falla, se rompió el escáner', () => {
    // Sin esto, un escáner que no mira nada pasaría las dos de arriba en
    // verde comparando contra la nada.
    const existen = adrsQueExisten(ADR);
    expect(existen.size, 'tiene que haber ADRs').toBeGreaterThan(20);
    expect(existen.has('0029'), 'el que motivó esta guarda').toBe(true);
    expect(existen.has('0031'), 'y el renumerado').toBe(true);
  });

  it('una cita a un número que nadie escribió se detecta', () => {
    // Contra una carpeta de ADR vacía —vacía de verdad, no inexistente—,
    // TODAS las citas del repo deberían aparecer: es la prueba de que el
    // escáner lee el código y no devuelve la lista vacía por otra razón.
    const vacia = mkdtempSync(join(tmpdir(), 'adr-vacia-'));
    try {
      const sinPaginas = adrsCitadasSinPagina(RAICES, vacia);
      expect(sinPaginas.length, 'el repo cita ADRs, así que sin páginas todas faltan').toBeGreaterThan(5);
    } finally {
      rmSync(vacia, { recursive: true, force: true });
    }
  });
});
