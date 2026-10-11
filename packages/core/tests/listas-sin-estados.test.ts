import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listasSinVacio, pantallasQueDesaparecen } from '../src/listas-sin-estados';

/**
 * Lo que «premium» significa en cosas comprobables (#588).
 *
 * «Premium» sin criterio produce churn: alguien retoca una pantalla, la de al
 * lado queda distinta, y el producto se ve menos parejo que antes. Lo que se ve
 * como «no premium» no es que algo sea feo — es que **no sea parejo**. Y la
 * única forma de que quede parejo es que una pantalla nueva sin estados no pase
 * el PR.
 *
 * ## Dos mecanismos, porque son dos problemas de tamaño distinto
 *
 * - **Esqueletos: SEIS pantallas**, con nombre, y la lista va acá con su
 *   motivo. A ese tamaño el motivo es información que no está en ninguna otra
 *   parte: «esto es el portón de sesión, devolver null es lo correcto» no se
 *   deduce del código. Mismo criterio que #447.
 * - **Vacíos: 41 colecciones**, y la lista va en `docs/listas-sin-vacio.txt`
 *   como trinquete. A ese tamaño, un motivo por entrada es trabajo sin valor
 *   por entrada: cuarenta y una líneas que dicen «falta» con palabras
 *   distintas. Mismo criterio que #703 con sus 201 columnas.
 *
 * Elegir el mecanismo por el tamaño no es pereza: una lista de 41 motivos no se
 * lee, y una lista que no se lee no se vacía.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const RAICES = [join(RAIZ, 'apps', 'web', 'components'), join(RAIZ, 'packages', 'ui', 'src', 'react')];
const LISTA = join(RAIZ, 'docs', 'listas-sin-vacio.txt');

function corto(archivo: string): string {
  return archivo
    .slice(RAIZ.length + 1)
    .replace(/^apps\/web\/components\//, '')
    .replace(/^packages\/ui\/src\/react\//, 'ui/');
}

/**
 * Las pantallas que desaparecen mientras cargan, con su motivo (#588).
 *
 * «Desaparecer» es `return null` gobernado por un estado de datos sin cargar y
 * sin ningún `<Skeleton>` en el cuerpo. Lo que se ve es un hueco que después
 * empuja lo de abajo: el salto que el criterio 3 del issue prohíbe.
 */
const SIN_ESQUELETO: Record<string, string> = {
  'evaluaciones.tsx#corridas':
    'El panel de Ajustes → IA no existe mientras cargan dos llamadas en cascada y después empuja lo de abajo. Entra en la tanda de #588.',
  'horarios-de-atencion.tsx#franjas':
    'Agenda se dibuja sin el panel de franjas y luego aparece, moviendo todo lo que está debajo. Entra en la tanda de #588.',
  'logro-del-objetivo.tsx#tasa':
    'Ya tiene un «Cargando…» de texto en el caso por caso, pero el panel entero falta mientras llega el dato. Entra en la tanda de #588.',
  'recordatorios-de-cita.tsx#datos':
    'Los dos Select de recordatorio aparecen de golpe en Agenda, sin título ni marco mientras cargan. Entra en la tanda de #588.',
  'retencion-del-negocio.tsx#datos':
    'La sección «Cuánto se guardan las conversaciones» de Ajustes no está y de pronto está. Entra en la tanda de #588.',

  // --- Lo que NO es un defecto, con su porqué ---
  'ui/session.tsx#session':
    'Es el PORTÓN de sesión: mientras no hay sesión no hay pantalla que esquelesar, y dibujar la silueta de algo que quizá nunca aparece —porque hay que iniciar sesión— es peor que el hueco. Devolver null es lo correcto.',

  // --- Lo que esta guarda NO puede ver, y va a mano ---
  //
  // El esqueleto se mide por COMPONENTE, así que un componente con quince
  // estados de carga y un solo `<Skeleton>` pasa en verde. La comprobación
  // correcta sería por estado de carga; mientras no exista, esto va escrito.
  'bandeja/bandeja.tsx#A_MANO':
    'A MANO: tiene un esqueleto para la lista y catorce estados nulos más; Chat y Ficha entran de golpe al abrir una conversación. La guarda no lo ve porque mide por componente y no por estado de carga.',
  'ui/audit-explorer.tsx#A_MANO':
    'A MANO: `cargando` solo apaga el botón Buscar; la tabla no tiene esqueleto, así que el mismo pixel sirve para «buscando» y para «no hay nada». Es lo que #588 anotó como auditoria.tsx, que solo le pasa el fetcher.',
};

describe('estados vacíos y esqueletos (#588)', () => {
  const enLaLista = readFileSync(LISTA, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  it('no aparece ninguna colección nueva sin estado vacío', () => {
    const ahora = listasSinVacio(RAICES).map((l) => `${corto(l.archivo)}#${l.arreglo}`);
    const nuevas = ahora.filter((e) => !enLaLista.includes(e));
    expect(
      nuevas,
      'Estas colecciones se dibujan y no dicen qué pasa cuando están vacías. La regla de Pulso ' +
        'pide `EstadoVacio` con qué va a aparecer ahí y la acción que lo provoca: una lista vacía ' +
        'que solo dice que está vacía es un callejón. Si de verdad no es una colección —una ' +
        'transcripción, un resultado de búsqueda— agrégala al trinquete con\n' +
        '  node scripts/listas-sin-vacio.mjs --escribir\n' +
        'y explica en el PR por qué no lo es:\n  ' +
        nuevas.join('\n  '),
    ).toEqual([]);
  });

  it('y si alguna estrenó su vacío, la marca BAJA', () => {
    const ahora = listasSinVacio(RAICES).map((l) => `${corto(l.archivo)}#${l.arreglo}`);
    const resueltas = enLaLista.filter((e) => !ahora.includes(e));
    expect(
      resueltas,
      'Estas ya tienen su estado vacío: la marca tiene que bajar. Corre\n' +
        '  node scripts/listas-sin-vacio.mjs --escribir\n' +
        'Sin esto el trinquete se afloja solo, y una deuda que no se ve bajar nunca baja:\n  ' +
        resueltas.join('\n  '),
    ).toEqual([]);
  });

  it('ninguna pantalla nueva desaparece mientras carga', () => {
    const ahora = pantallasQueDesaparecen(RAICES).map((p) => `${corto(p.archivo)}#${p.dato}`);
    const nuevas = ahora.filter((p) => !(p in SIN_ESQUELETO));
    expect(
      nuevas,
      'Estas pantallas devuelven `null` mientras cargan y no dibujan ningún `Skeleton`: se ve un ' +
        'hueco que después empuja lo de abajo. Un esqueleto del alto del contenido real evita el ' +
        'salto. Si devolver null es lo correcto —un portón, un aviso que no aplica— agrégala a ' +
        'SIN_ESQUELETO con el motivo:\n  ' +
        nuevas.join('\n  '),
    ).toEqual([]);
  });

  it('y si alguna estrenó su esqueleto, se saca de la lista', () => {
    const ahora = pantallasQueDesaparecen(RAICES).map((p) => `${corto(p.archivo)}#${p.dato}`);
    const resueltas = Object.keys(SIN_ESQUELETO).filter(
      (p) => !p.endsWith('#A_MANO') && !ahora.includes(p),
    );
    expect(
      resueltas,
      'Estas ya tienen esqueleto: sácalas de SIN_ESQUELETO. Una lista que dice «falta» de algo ' +
        'construido es un mapa viejo, y el próximo que la lea va a creerle:\n  ' +
        resueltas.join('\n  '),
    ).toEqual([]);
  });

  it('cada excepción de esqueleto explica POR QUÉ', () => {
    // Un motivo de tres palabras es una excepción muda con adorno. El criterio 2
    // de #588 pide justamente eso: «listados con motivo, no como excepción muda».
    const mudas = Object.entries(SIN_ESQUELETO)
      .filter(([, motivo]) => motivo.trim().length < 40)
      .map(([k]) => k);
    expect(mudas, 'Escribe el motivo de verdad, no una etiqueta').toEqual([]);
  });

  it('el escáner distingue una lista de un desplegable', () => {
    // La prueba del escáner mismo: si esto se rompe, los números de arriba
    // dejan de significar lo que dicen, y las dos listas se vuelven adorno.
    const todo = listasSinVacio(RAICES).map((l) => `${corto(l.archivo)}#${l.arreglo}`);
    // `tenant-switcher` mapea los negocios a `DropdownMenuItem`: es un menú.
    expect(todo.filter((e) => e.startsWith('tenant-switcher'))).toEqual([]);
    // Y el proveedor del arranque no dibuja ninguna colección.
    expect(todo.filter((e) => e.startsWith('arranque.tsx'))).toEqual([]);
  });
});
