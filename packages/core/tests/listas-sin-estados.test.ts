import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * - **Vacíos:** `docs/listas-sin-vacio.txt` es el trinquete generado. Cada
 *   entrada explica su caso real y cita el código en
 *   `docs/listas-sin-vacio-motivos.json`; la prueba de motivos comprueba
 *   cobertura exacta y anclas existentes. La lista sola no cumplía el
 *   criterio 2: un número no explica una excepción.
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
  // Las secciones que estaban acá tienen esqueleto medido en
  // `apps/web/e2e/esqueletos-medidos.spec.ts`. Las CINCO listas originales de
  // #588 también se miden en `cinco-listas-medidas.spec.ts`, incluyendo
  // Auditoría y Campana (que no formaban parte de la primera medición).
  // compara los dos estados del mismo locator y falla si se separan más de
  // 16 px. Lo que estaba a ojo no estaba cerca —al horario de atención le
  // faltaban 600 px, media pantalla de celular moviéndose de golpe—, así que
  // el «medido, no a ojo» del criterio 4 del issue no era una formalidad.

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
};

describe('estados vacíos y esqueletos (#588)', () => {
  it('una lista NO hereda el estado vacío de su vecina (#1068)', () => {
    // El agujero medido el 25/10: el escáner descartaba el ARCHIVO entero si
    // veía `EstadoVacio` en cualquier parte, aunque su unidad declarada sea
    // la colección. Al ponerle vacío a `fuentes`, `productos` salió de la
    // lista sin que nadie la mirara — y un trinquete que se afloja solo deja
    // de ser un trinquete.
    const directorio = mkdtempSync(join(tmpdir(), 'iaxti-vecinas-'));
    const archivo = join(directorio, 'dos-listas.tsx');
    try {
      writeFileSync(archivo, `
        const [fuentes, setFuentes] = useState<F[] | null>(null);
        const [productos, setProductos] = useState<P[] | null>(null);
        if (!fuentes) return <Skeleton />;
        return <>
          {fuentes.length === 0 ? (
            <EstadoVacio titulo="Sin fuentes" descripcion="Acá van tus horarios y precios." accion={{ etiqueta: 'Agregar', href: '/x' }} />
          ) : (
            <ul>{fuentes.map((f) => <li>{f.nombre}</li>)}</ul>
          )}
          <ul>{productos.map((p) => <li>{p.nombre}</li>)}</ul>
        </>;
      `);
      // La que tiene su vacío sale; la vecina se queda.
      expect(listasSinVacio([directorio])).toEqual([
        { archivo, arreglo: 'productos', silencioso: true },
      ]);
    } finally { rmSync(directorio, { recursive: true, force: true }); }
  });

  it('el vacío vale aunque la colección pregunte «=== 0» en más de un lugar (#1068)', () => {
    // Al mirar solo la PRIMERA rama de vacío, `crm/contactos.tsx#items`
    // aparecía como pendiente teniendo su EstadoVacio pegado al map: su
    // primer `=== 0` era el del aviso de arriba.
    const directorio = mkdtempSync(join(tmpdir(), 'iaxti-dos-ramas-'));
    const archivo = join(directorio, 'dos-ramas.tsx');
    try {
      writeFileSync(archivo, `
        const [items, setItems] = useState<I[] | null>(null);
        if (!items) return <Skeleton />;
        const aviso = items.length === 0 ? 'nada por ahora' : '';
        return <>
          <p>{aviso}</p>
          {items.length === 0 ? (
            <EstadoVacio titulo="Sin contactos" descripcion="Acá van las personas que te escriben." accion={{ etiqueta: 'Importar', href: '/x' }} />
          ) : (
            <ul>{items.map((i) => <li>{i.nombre}</li>)}</ul>
          )}
        </>;
      `);
      expect(listasSinVacio([directorio])).toEqual([]);
    } finally { rmSync(directorio, { recursive: true, force: true }); }
  });

  it('detecta una pantalla nueva sin estados aunque los mencione en comentarios', () => {
    const directorio = mkdtempSync(join(tmpdir(), 'iaxti-listas-'));
    const archivo = join(directorio, 'pantalla-nueva.tsx');
    try {
      writeFileSync(archivo, `
        // Añadir EstadoVacio y Skeleton después no puede poner esto en verde.
        const [items, setItems] = useState<Item[] | null>(null);
        if (!items) return null;
        return <ul>{items.map((item) => <li>{item.nombre}</li>)}</ul>;
      `);
      expect(listasSinVacio([directorio])).toEqual([{ archivo, arreglo: 'items', silencioso: true }]);
      expect(pantallasQueDesaparecen([directorio])).toEqual([{ archivo, dato: 'items' }]);
      writeFileSync(archivo, `
        const [items, setItems] = useState<Item[] | null>(null);
        if (!items) return <Skeleton />;
        if (items.length === 0) return <EstadoVacio titulo="Sin elementos" descripcion="Aquí se verán los elementos creados." accion={{ etiqueta: 'Crear', href: '/crear' }} />;
        return <ul>{items.map((item) => <li>{item.nombre}</li>)}</ul>;
      `);
      expect(listasSinVacio([directorio])).toEqual([]);
      expect(pantallasQueDesaparecen([directorio])).toEqual([]);
    } finally { rmSync(directorio, { recursive: true, force: true }); }
  });

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
