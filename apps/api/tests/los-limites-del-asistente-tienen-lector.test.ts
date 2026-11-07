import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { OPERACIONES_DE_LA_API } from '../../../packages/modules/agents/application/catalogo.generated';

/**
 * El esquema del asistente y sus LECTORES no se pueden desincronizar (#1232).
 *
 * El defecto que cerró #1232 fue un `jsonb` libre: `limits` aceptaba cualquier
 * llave y solo cinco se leían, así que la llave mal escrita se guardaba sin
 * hacer nada. El esquema zod lo arregla hoy — y mañana se rompe solo, porque
 * agregar una llave a un lado y no al otro no produce ningún error:
 *
 *  - llave NUEVA en el esquema sin lector → se guarda y no hace nada: es el
 *    defecto de antes con mejor presentación;
 *  - llave NUEVA en el lector sin esquema → el PUT la rechaza, y el síntoma que
 *    llega es «no me deja guardar» en una función recién construida.
 *
 * Las dos formas son silenciosas, así que la guarda mira las dos direcciones y
 * lo hace contra el CÓDIGO: la lista de llaves sale del esquema que de verdad
 * valida (el que `@Cuerpo` registra, el mismo que publica el catálogo) y de la
 * fuente de los lectores, no de una copia escrita acá.
 *
 * Y escanea la fuente LIMPIA (#569): este archivo nombra `confidence_threshold`
 * y `max_executions_day` en sus comentarios, y sin eso la guarda se pondría
 * roja por el comentario que la explica.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const AGENTS = join(RAIZ, 'packages/modules/agents/application');

/** Un esquema JSON de objeto, como lo publica `z.toJSONSchema`. */
interface EsquemaDeObjeto {
  properties?: Record<string, EsquemaDeObjeto>;
  required?: string[];
  additionalProperties?: boolean;
  /** Lo que el modelo necesita para no adivinar: la lista y el tope. */
  enum?: string[];
  maximum?: number;
}

/**
 * El cuerpo de una función, de su firma hasta la siguiente declaración
 * exportada. Permite preguntar «qué lee ESTA función» en vez de «qué nombra el
 * archivo», que es lo que hace a la guarda específica.
 *
 * El corte NO puede ser «la primera llave en la columna cero»: lo intenté así
 * y `guardrailLimits` devolvió cero llaves, porque su tipo de retorno es un
 * objeto escrito en varias líneas y su `} {` cierra en la columna cero ANTES
 * del cuerpo. La guarda se puso roja mostrando solo `pulso`, y si la hubiera
 * escrito al revés —comprobando que el esquema no tenga llaves de más— habría
 * pasado en verde comparando contra la nada.
 */
function cuerpoDe(archivo: string, funcion: string): string {
  const texto = fuenteLimpia(readFileSync(join(AGENTS, archivo), 'utf8'));
  const desde = texto.indexOf(`export function ${funcion}(`);
  expect(desde, `no encontré ${funcion} en ${archivo}`).toBeGreaterThan(-1);
  const siguiente = texto.indexOf('\nexport ', desde + 1);
  const cuerpo = texto.slice(desde, siguiente === -1 ? undefined : siguiente);
  // Una tajada vacía o cortada dejaría pasar cualquier cosa: el `return` es la
  // señal mínima de que el cuerpo entró completo.
  expect(cuerpo, `la tajada de ${funcion} quedó sin cuerpo`).toContain('return');
  return cuerpo;
}

/** Las llaves que una función lee de un objeto, por `variable.llave`. */
function llavesLeidas(cuerpo: string, variable: string): Set<string> {
  const re = new RegExp(`\\b${variable}\\.([a-z_][a-z0-9_]*)\\b`, 'g');
  return new Set([...cuerpo.matchAll(re)].map((m) => m[1]));
}

function propiedades(esquema: EsquemaDeObjeto | undefined): Set<string> {
  return new Set(Object.keys(esquema?.properties ?? {}));
}

let cuerpoDelPut: EsquemaDeObjeto;

beforeAll(async () => {
  // El registro ocurre cuando el decorador se EVALÚA, así que hay que importar
  // el controlador de verdad. Se importa SOLO él y no `app.module`: medido en
  // `la-validacion-va-en-esquemas.test.ts`, la app entera cuesta 2,6 s y acá no
  // hace falta ninguna ruta levantada.
  await import('../src/agents.controller');
  const { ESQUEMAS_DE_CUERPO } = await import('../src/validar');
  cuerpoDelPut = ESQUEMAS_DE_CUERPO.get('AgentsController_update') as EsquemaDeObjeto;
  expect(cuerpoDelPut, 'el PUT del asistente no registró su esquema').toBeTruthy();
}, 30_000);

describe('el esquema del asistente y sus lectores (#1232)', () => {
  it('`limits` declara exactamente las llaves que el producto lee', () => {
    const delEsquema = propiedades(cuerpoDelPut.properties?.limits);
    const deLosLectores = new Set([
      // `guardrailLimits` lee `agent.limits` en una variable local `l`.
      ...llavesLeidas(cuerpoDe('autonomous.ts', 'guardrailLimits'), 'l'),
      // `configDelPulso` recibe el objeto y lee `limits.pulso`.
      ...llavesLeidas(cuerpoDe('pulso.ts', 'configDelPulso'), 'limits'),
    ]);
    expect(
      [...delEsquema].sort(),
      'El esquema de `limits` y lo que el producto lee dejaron de calzar. Si agregaste un ' +
        'guardarriel, va en LOS DOS lados: el esquema de `LimitesDelAsistente` ' +
        '(agents.controller.ts) y su lector. Una llave que solo está en el esquema se guarda ' +
        'y no hace nada; una que solo está en el lector no se puede guardar.',
    ).toEqual([...deLosLectores].sort());
  });

  it('`pulso` declara exactamente lo que `configDelPulso` lee de él', () => {
    const delEsquema = propiedades(cuerpoDelPut.properties?.limits?.properties?.pulso);
    // Dentro de `configDelPulso` el objeto del pulso se lee por `o`.
    const delLector = llavesLeidas(cuerpoDe('pulso.ts', 'configDelPulso'), 'o');
    expect([...delEsquema].sort()).toEqual([...delLector].sort());
  });

  it('`autonomousHours` declara exactamente lo que `inAutonomousHours` lee', () => {
    const delEsquema = propiedades(cuerpoDelPut.properties?.autonomousHours);
    const delLector = llavesLeidas(cuerpoDe('autonomous.ts', 'inAutonomousHours'), 'hours');
    expect([...delEsquema].sort()).toEqual([...delLector].sort());
  });

  it('las tres llaves del pulso que lo prenden son obligatorias juntas', () => {
    // `configDelPulso` devuelve null —pulso apagado— si falta cualquiera de las
    // tres. Dejarlas opcionales en el esquema es admitir un pulso que se ve
    // prendido y no manda nunca, que es el silencio de este issue en la función
    // que más rápido puede costar un número de WhatsApp.
    const pulso = cuerpoDelPut.properties?.limits?.properties?.pulso;
    expect([...(pulso?.required ?? [])].sort()).toEqual(['activo', 'desde', 'hasta']);
  });

  it('la pantalla de modo autónomo reenvía las mismas llaves y ninguna más', () => {
    // La pantalla toca tres guardarrieles y tiene que reenviar los otros,
    // porque el PUT reemplaza `limits` completo. Su lista es la que decide qué
    // vuelve al servidor: si se queda corta, guardar la confianza mínima apaga
    // el pulso; si se pasa, la pantalla se traba con su propio eco.
    const fuente = fuenteLimpia(
      readFileSync(join(RAIZ, 'apps/web/components/modo-autonomo.tsx'), 'utf8'),
    );
    const bloque = /LLAVES_DE_LIMITS[^=]*=\s*\[([^\]]*)\]/.exec(fuente);
    expect(bloque, 'la pantalla ya no declara LLAVES_DE_LIMITS').toBeTruthy();
    const deLaPantalla = [...bloque![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...deLaPantalla].sort()).toEqual([...propiedades(cuerpoDelPut.properties?.limits)].sort());
  });
});

/**
 * Y lo que todo esto habilita: que el Agente General pueda configurar.
 *
 * La pantalla de detalle del asistente le dice al dueño «para cambiarlo,
 * pídeselo conversando», y el catálogo publicaba `AgentsController_update` con
 * `properties: { id }` — solo el id de la ruta. Las tres herramientas existían,
 * el modelo las ofrecía, y no tenían un solo campo que mandar: función
 * construida, sin puerta, y la puerta que falta no se ve faltar.
 */
describe('el Agente General puede configurar el asistente (#1232)', () => {
  it('las tres operaciones de escritura publican campos de verdad', () => {
    for (const [op, esperado] of [
      ['AgentsController_update', 'limits'],
      ['AgentsController_create', 'objetivo'],
      ['AgentsController_guardarAjustesDeIa', 'soloProveedor'],
    ] as const) {
      const args = OPERACIONES_DE_LA_API[op].argumentos as EsquemaDeObjeto;
      const campos = propiedades(args);
      // `id` viene de la ruta y no es algo que el modelo pueda configurar: sin
      // sacarlo, la cuenta de abajo pasaría con el catálogo roto de antes.
      campos.delete('id');
      expect(campos.size, `${op} no publica campos`).toBeGreaterThan(1);
      expect([...campos], op).toContain(esperado);
    }
  });

  it('el modelo ve los enums y los rangos, no solo los nombres', () => {
    const args = OPERACIONES_DE_LA_API.AgentsController_update.argumentos as EsquemaDeObjeto;
    expect(
      args.properties?.provider?.enum,
      'sin la lista de proveedores el modelo adivina',
    ).toEqual(expect.arrayContaining(['glm', 'google']));
    expect(
      args.properties?.limits?.properties?.confidence_threshold?.maximum,
      'sin el rango publicado, el modelo vuelve a mandar 5',
    ).toBe(1);
  });
});
