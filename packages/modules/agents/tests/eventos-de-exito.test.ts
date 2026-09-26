import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFINICIONES } from '../domain/objetivo';

/**
 * Cada objetivo cierra con un evento que EXISTE y trae la llave que se lee (#544).
 *
 * El objetivo «Cobrar» declaraba `payment.confirmed` como evento de éxito. Ese
 * nombre no existe en ningún manifiesto ni en ningún `publishEvent` del repo:
 * las dos únicas apariciones eran sus propias declaraciones. Consecuencia: cada
 * intento de ese objetivo terminaba en «perdido» al vencer la ventana de
 * atribución, y la tasa de logro decía 0 % para siempre — con el negocio
 * mirando esa cifra para decidir si el asistente le sirve.
 *
 * Y renombrarlo a secas no alcanzaba: el mapa `REFERENCIA` esperaba `paymentId`
 * y el payload de `payment.received` trae `linkId`. O sea que el defecto tenía
 * dos mitades, y esta guarda mira las dos.
 *
 * `eventos-declarados.test.ts` de core cruza publicadores con consumidores; los
 * eventos de ÉXITO son una tercera superficie que no cubría.
 */
const MODULOS = join(__dirname, '..', '..');

function archivos(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (['node_modules', 'dist', 'tests'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivos(ruta, acc);
    else if (ruta.endsWith('.ts') || ruta.endsWith('.yaml')) acc.push(ruta);
  }
  return acc;
}

const FUENTES = archivos(MODULOS);

/** Los eventos que algún `module.yaml` declara publicar. */
function publicados(): Set<string> {
  const salida = new Set<string>();
  for (const archivo of FUENTES.filter((f) => f.endsWith('module.yaml'))) {
    const crudo = readFileSync(archivo, 'utf8');
    const bloque = /publishes:\s*\n((?:\s+-.*\n?)*)/.exec(crudo);
    if (!bloque) continue;
    for (const m of bloque[1].matchAll(/-\s*([a-z][a-z0-9_.]*)/g)) salida.add(m[1]);
  }
  return salida;
}

/** El payload con el que se publica cada evento, tal como está escrito. */
function payloadDe(evento: string): string | null {
  for (const archivo of FUENTES.filter((f) => f.endsWith('.ts'))) {
    const texto = readFileSync(archivo, 'utf8');
    const i = texto.indexOf(`name: '${evento}'`);
    if (i === -1) continue;
    // Desde el nombre hasta el cierre de la llamada: alcanza para ver las
    // llaves del payload, que van justo después.
    return texto.slice(i, i + 700);
  }
  return null;
}

/** El mapa evento → campo del payload, leído del archivo que lo define. */
function referencias(): Record<string, string> {
  const texto = readFileSync(join(__dirname, '..', 'application', 'objetivo-medido.ts'), 'utf8');
  const bloque = /const REFERENCIA: Record<string, string> = \{([\s\S]*?)\n\};/.exec(texto);
  if (!bloque) throw new Error('No encontramos el mapa REFERENCIA.');
  return Object.fromEntries(
    [...bloque[1].matchAll(/'([a-z][a-z0-9_.]*)':\s*'([a-zA-Z]+)'/g)].map((m) => [m[1], m[2]]),
  );
}

const DE_LOS_OBJETIVOS = [...new Set(Object.values(DEFINICIONES).flatMap((d) => d.eventoDeExito))];

describe('los eventos de éxito de los objetivos (#544)', () => {
  it('el escáner encuentra objetivos y eventos', () => {
    expect(Object.keys(DEFINICIONES).length).toBeGreaterThan(3);
    expect(DE_LOS_OBJETIVOS.length).toBeGreaterThan(2);
    expect(publicados().size).toBeGreaterThan(20);
  });

  it('todo evento de éxito lo publica algún módulo', () => {
    const publica = publicados();
    const inventados = DE_LOS_OBJETIVOS.filter((e) => !publica.has(e));
    expect(
      inventados,
      'Estos eventos cierran un objetivo y ningún manifiesto los publica. El intento ' +
        'termina siempre en «perdido» al vencer la ventana, y la tasa de logro dice 0 % ' +
        'para siempre:\n  ' + inventados.join('\n  '),
    ).toEqual([]);
  });

  it('todo evento de éxito se publica de verdad en algún lado, no solo en el manifiesto', () => {
    // Un manifiesto puede declarar un evento que nadie publica; eso lo cubre la
    // guarda de core. Acá importa porque un objetivo que espera un evento no
    // publicado es un objetivo que no se cierra nunca.
    const sinPublicador = DE_LOS_OBJETIVOS.filter((e) => payloadDe(e) === null);
    expect(sinPublicador, 'nadie los publica en el código:\n  ' + sinPublicador.join('\n  ')).toEqual([]);
  });

  it('la llave que el medidor lee está en el payload que se publica', () => {
    // La otra mitad del defecto. `payment.confirmed` → `paymentId` habría
    // seguido roto después de renombrar el evento, porque el payload de
    // `payment.received` trae `linkId`.
    const mapa = referencias();
    const malas: string[] = [];
    for (const evento of DE_LOS_OBJETIVOS) {
      const llave = mapa[evento];
      if (!llave) {
        malas.push(`${evento}: no está en REFERENCIA, así que el resultado queda sin id`);
        continue;
      }
      const payload = payloadDe(evento);
      if (payload && !new RegExp(`\\b${llave}\\b`).test(payload)) {
        malas.push(`${evento}: REFERENCIA espera "${llave}" y el payload no lo trae`);
      }
    }
    expect(malas, malas.join('\n  ')).toEqual([]);
  });

  it('REFERENCIA no junta polvo: nada de eventos que ya no cierran nada', () => {
    const deSobra = Object.keys(referencias()).filter((e) => !DE_LOS_OBJETIVOS.includes(e));
    expect(deSobra, 'Sácalos de REFERENCIA: ningún objetivo los usa').toEqual([]);
  });
});
