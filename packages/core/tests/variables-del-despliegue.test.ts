import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  variablesQueEntregaElCompose,
  variablesQueLeeElCodigo,
} from '../src/variables-del-despliegue';

/**
 * El compose decide qué variables de entorno entran al contenedor.
 *
 * Las cinco variables de SMTP estaban cargadas en Dokploy y el correo seguía
 * sin salir. No era el correo: era que `x-env` no las nombraba, así que
 * nunca llegaron al contenedor. Medido en staging ese día: Dokploy guardaba
 * 19 variables y el contenedor recibía 10.
 *
 * Ninguna de las que faltaban hacía reventar nada. `smtp()` devuelve null y
 * queda la campana; el worker avisa "realtime de bandeja apagado" y sigue;
 * `embeddingsAvailable()` es false. O sea: funciones apagadas en silencio,
 * sin log, sin que `/ready` lo note. Mismo patrón de siempre en este
 * proyecto — declarado en un lado, aplicado en ninguno.
 *
 * El caso de producción era peor: el archivo pasaba SOLO `SERVICE`.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const STAGING = join(RAIZ, 'infra', 'dokploy', 'docker-compose.staging.yml');
const PROD = join(RAIZ, 'infra', 'dokploy', 'docker-compose.prod.yml');
const FUERA = join(RAIZ, 'infra', 'dokploy', 'variables-fuera-del-despliegue.json');

const leidas = variablesQueLeeElCodigo([join(RAIZ, 'apps'), join(RAIZ, 'packages')]);
const staging = variablesQueEntregaElCompose(STAGING);
const prod = variablesQueEntregaElCompose(PROD);

const fuera = JSON.parse(readFileSync(FUERA, 'utf8')) as Record<string, unknown>;
const exentas = new Set(Object.keys(fuera).filter((k) => k !== '_'));

/** Ruta relativa, que la absoluta no le sirve a nadie en el rojo de CI. */
const corta = (a: string) => a.slice(RAIZ.length + 1);

describe('el compose pasa las variables que el código lee', () => {
  it('el escáner encuentra algo (si esto falla, el escáner se rompió)', () => {
    expect(leidas.length).toBeGreaterThan(30);
    expect(staging.size).toBeGreaterThan(30);
  });

  it('las lee desestructurando también', () => {
    // `email.ts` hace `const { SMTP_HOST, ... } = process.env`. Un escáner
    // que solo mire `process.env.X` da verde sobre el bug que lo motivó.
    const nombres = leidas.map((v) => v.nombre);
    expect(nombres).toContain('SMTP_HOST');
    expect(nombres).toContain('SMTP_PASS');
  });

  it('no cuenta las variables que solo aparecen en comentarios', () => {
    const nombres = leidas.map((v) => v.nombre);
    expect(nombres).not.toContain('FOO');
    expect(nombres).not.toContain('X');
  });

  for (const compose of [
    { nombre: 'staging', claves: staging },
    { nombre: 'producción', claves: prod },
  ]) {
    it(`${compose.nombre} pasa toda variable leída, o está exenta con su motivo`, () => {
      const faltantes = leidas
        .filter((v) => !compose.claves.has(v.nombre) && !exentas.has(v.nombre))
        .map((v) => `  ${v.nombre} — se lee en ${v.archivos.map(corta).join(', ')}`);

      expect(
        faltantes,
        [
          `${faltantes.length} variable(s) que el código lee y ${compose.nombre} no pasa al contenedor.`,
          'Agrégala al bloque x-env de los DOS compose, o a',
          'infra/dokploy/variables-fuera-del-despliegue.json con el motivo.',
          '',
          ...faltantes,
        ].join('\n'),
      ).toEqual([]);
    });
  }

  it('los dos compose pasan exactamente las mismas variables', () => {
    // Prod se desincronizó de staging sin que nada lo dijera: perdió el
    // bloque x-env entero y el comentario siguió diciendo "igual que
    // staging". Los valores cambian por ambiente; los NOMBRES no.
    const soloStaging = [...staging].filter((v) => !prod.has(v)).sort();
    const soloProd = [...prod].filter((v) => !staging.has(v)).sort();
    expect({ soloStaging, soloProd }).toEqual({ soloStaging: [], soloProd: [] });
  });

  it('la lista de exentas no acumula variables que ya nadie lee', () => {
    const nombres = new Set(leidas.map((v) => v.nombre));
    const sobrantes = [...exentas].filter((v) => !nombres.has(v));
    expect(sobrantes, `sobran en la lista de exentas: ${sobrantes.join(', ')}`).toEqual([]);
  });

  it('cada exenta trae un motivo escrito, no una cadena vacía', () => {
    for (const nombre of exentas) {
      expect(typeof fuera[nombre], `${nombre} sin motivo`).toBe('string');
      expect((fuera[nombre] as string).length, `el motivo de ${nombre} es muy corto`).toBeGreaterThan(40);
    }
  });
});
