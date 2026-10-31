import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Pantallas que dibujan una colección sin decir qué pasa cuando está vacía, y
 * pantallas que DESAPARECEN mientras cargan (#588).
 *
 * ## Por qué no se infiere «esto es una lista»
 *
 * El intento obvio es buscar `.map(` y pedir estados. Medido: en
 * `app-shell.tsx` solo, eso da cinco aciertos y cinco ruidos — menús,
 * desplegables, pestañas. Y una guarda que grita de más se apaga igual de
 * rápido que una que no grita.
 *
 * La señal buena es otra, y es *positiva*: **el autor ya escribió la rama**. Un
 * componente que puede venir vacío lo dice en el código —`items.length === 0`,
 * `!datos.length`— y lo que falla es con QUÉ lo dibuja: un `<p>` gris en vez de
 * `EstadoVacio` con su acción. No hay que adivinar la intención: está escrita.
 *
 * El otro caso es el que no la escribió: mapea y no tiene ninguna rama de
 * vacío. Ese es el peor —un `<ul>` que no dice nada— y es el que hace fallar a
 * una pantalla nueva.
 *
 * ## Dos comprobaciones INDEPENDIENTES, nunca una
 *
 * Clasificadas las 27 pantallas sin estados: cuatro piden vacío, diez piden
 * esqueleto, y solo tres piden los dos. Exigir el par convertiría una sección
 * de un campo y un panel de métricas en entradas falsas de «falta el vacío», y
 * ahí es donde empieza el apagado.
 *
 * ## Lo que esto NO puede ver, dicho para que nadie lo suponga
 *
 * El esqueleto se mide por COMPONENTE, así que un componente con quince
 * estados de carga y un solo `<Skeleton>` pasa en verde. `bandeja.tsx` es
 * exactamente eso. La comprobación correcta sería por estado de carga y no por
 * componente; mientras no exista, esos casos van en la lista a mano.
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', 'e2e', 'tests']);

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (/\.tsx$/.test(entrada)) acc.push(ruta);
  }
  return acc;
}

/**
 * Lo que un `map` devuelve cuando NO es una lista: un menú, un desplegable, una
 * pestaña. Se mira lo que el `map` DEVUELVE y no lo que contiene — ese fue el
 * recorte que probé primero y descarté, porque sacaba `etiquetas`, `empresas`,
 * `embudos` y `roles`, que son listas de verdad con edición en línea. Un
 * control dentro de la fila es normal; lo que distingue es qué se produce.
 */
const NO_ES_LISTA = [
  'SelectItem',
  'CommandItem',
  'DropdownMenuItem',
  'MenubarItem',
  'TabsTrigger',
  'ToggleGroupItem',
  'option',
];

/**
 * Tipos que NO son «estado de datos sin cargar».
 *
 * Es el filtro que hace que la señal del esqueleto sirva. Sin él entran
 * `error`, `aviso`, `tenant`, `ocupado`, `editando` — porque el `setError(null)`
 * vive en la misma función que carga, así que el `return null` por un primitivo
 * parece carga y no lo es. Medido: con este filtro, cinco hallazgos en 72
 * componentes y cero ruido.
 */
const PRIMITIVO = /\b(string|boolean|number|File|Date|Record<|Set<|Map<)\b/;

export interface ListaSinVacio {
  archivo: string;
  arreglo: string;
  /** `true` si el componente NI SIQUIERA escribió la rama de vacío. */
  silencioso: boolean;
}

export interface PantallaQueDesaparece {
  archivo: string;
  /** El dato por el que devuelve null, para poder nombrarlo en el mensaje. */
  dato: string;
}

/** Los arreglos que el componente declara: estado con tipo lista, o prop lista. */
function arreglosDelComponente(codigo: string): string[] {
  const nombres = new Set<string>();
  for (const m of codigo.matchAll(/const \[(\w+), set\w+\] = useState<([^>]*?)>/g)) {
    if (/\[\]/.test(m[2])) nombres.add(m[1]);
  }
  for (const m of codigo.matchAll(/^\s*(\w+)\??:\s*\w[\w.<>|\s]*\[\]/gm)) nombres.add(m[1]);
  /**
   * Y las que llegan por un hook (#1129).
   *
   * Las dos señales de arriba miran DECLARACIONES: un `useState` con tipo de
   * arreglo, o un campo de props tipado. Un componente que recibe la lista de
   * un hook —`const { turnos } = useAgente()`— no declara ninguna de las dos,
   * así que el escáner no lo veía.
   *
   * Cómo apareció: al partir el Agente General en tres, el hilo se fue a
   * `agente/estado.tsx` y el render quedó en `agente/conversacion.tsx`. El
   * trinquete dijo «RESUELTA» por dos entradas que nadie había arreglado — la
   * deuda no bajó, se volvió invisible, que es peor que no haberla contado
   * nunca.
   *
   * Se exige que el nombre se MAPEE, no solo que esté desestructurado: un
   * hook devuelve también funciones y banderas, y contarlas todas sería ruido.
   * Medido al agregarlo: una sola colección nueva en todo `apps/web`, que es
   * exactamente la que se había escondido.
   */
  for (const m of codigo.matchAll(/const \{([^}]*)\} = use[A-Z]\w*\(/g)) {
    for (const crudo of m[1].split(',')) {
      const nombre = crudo.trim().split(':')[0]?.trim();
      if (!nombre || !/^\w+$/.test(nombre) || nombres.has(nombre)) continue;
      // `x.map(`, `x?.map(` y `(x ?? []).map(`, que es como se dibuja una
      // lista que puede no haber llegado.
      const mapeada = new RegExp(
        `\\b${nombre}(?:\\?)?\\.map\\(|\\b${nombre}\\s*\\?\\?\\s*\\[\\]\\s*\\)\\s*\\.map\\(`,
      );
      if (mapeada.test(codigo)) nombres.add(nombre);
    }
  }
  return [...nombres];
}

export function listasSinVacio(raices: string[]): ListaSinVacio[] {
  const hallazgos: ListaSinVacio[] = [];
  for (const archivo of raices.flatMap((r) => fuentes(r))) {
    const codigo = fuenteLimpia(readFileSync(archivo, 'utf8'));
    // Atajo barato: sin un `.map(` no hay lista que dibujar. El filtro que
    // había acá —descartar el archivo entero si mencionaba `EstadoVacio`— es
    // justo lo que #1068 vino a sacar.
    if (!codigo.includes('.map(')) continue;
    for (const arreglo of arreglosDelComponente(codigo)) {
      /**
       * El vacío se mide POR COLECCIÓN, no por archivo (#1068).
       *
       * Esto era `if (codigo.includes('EstadoVacio')) continue` sobre el
       * archivo entero, y contradecía la unidad que este escáner declara: un
       * componente dibuja tres listas y ponerle vacío a UNA sacaba a las
       * otras dos de la lista sin que nadie las mirara. Medido el 25/10 al
       * arreglar `conocimiento.tsx#fuentes`: `#productos` salió sola.
       *
       * La señal correcta es de proximidad: un `EstadoVacio` dentro de la
       * rama de vacío de ESTA colección. La ventana son 600 caracteres
       * después del `x.length === 0` —el largo de un `EstadoVacio` con sus
       * cuatro props bien escritas más el ternario que lo envuelve— y no más,
       * porque a mil caracteres empieza a alcanzar la lista de al lado.
       */
      // TODAS las ramas de vacío de esta colección, no la primera: una lista
      // puede preguntar `=== 0` en dos lugares —el aviso de arriba y el
      // cuerpo— y el `EstadoVacio` estar solo en el segundo. Mirando solo la
      // primera, `crm/contactos.tsx#items` aparecía como pendiente teniendo
      // su vacío pegado al `map`.
      const ramas = [
        ...codigo.matchAll(
          new RegExp(`\\b${arreglo}(?:\\?)?\\.length\\s*===\\s*0|!\\s*${arreglo}(?:\\?)?\\.length\\b`, 'g'),
        ),
      ];
      if (ramas.some((r) => codigo.slice(r.index, r.index + 600).includes('EstadoVacio'))) continue;
      /**
       * Señal A: el autor ya escribió la rama de VACÍO.
       *
       * Solo `=== 0` y `!x.length`. Probé incluyendo `> 0` y `&&` —«dibuja si
       * hay»— y el ruido subió de 30 a 55: esas dos formas son renderizado
       * condicional de cualquier cosa, no la pregunta «¿qué ve alguien cuando
       * no hay nada?». Son parecidas de leer y distintas de significado.
       */
      const declarado = new RegExp(
        `\\b${arreglo}(?:\\?)?\\.length\\s*===\\s*0|!\\s*${arreglo}(?:\\?)?\\.length\\b`,
      ).test(codigo);
      // Señal B: lo mapea y no hay ninguna rama de vacío.
      const mapeaSinRama = new RegExp(
        `\\{\\s*(?:\\(\\s*)?${arreglo}\\s*(?:\\?\\?\\s*\\[\\]\\s*\\)\\s*)?(?:\\?)?\\.(?:map|filter)\\(`,
      ).test(codigo);
      /**
       * Y la condición que de verdad define «lista»: que se DIBUJE.
       *
       * Sin esto entraban arreglos que se recorren para armar un payload, para
       * construir las opciones de un control, o para contar algo —`valores`,
       * `etapasDisponibles`, `datosMinimos`—. Medido: 46 hallazgos sin esta
       * condición, 24 con ella. Un `.map` dentro de llaves de JSX es lo que
       * produce filas que una persona mira; un `.map` suelto produce datos.
       */
      const seDibuja = new RegExp(
        `\\{\\s*(?:\\(\\s*)?${arreglo}\\b[^;{]{0,200}?\\.map\\(`,
      ).test(codigo);
      if (!seDibuja) continue;
      if (!declarado && !mapeaSinRama) continue;

      // El recorte: lo que el `map` DEVUELVE.
      // El `\\(?` después de `=>` no es cosmético: el idioma normal es
      // `.map((m) => (\n  <SelectItem …`, con paréntesis y salto de línea, y sin
      // admitirlo el recorte no se disparaba nunca — `tenant-switcher` entraba
      // como lista cuando es un desplegable. Lo cazó la prueba del escáner.
      const elMap = new RegExp(
        `${arreglo}[^;]{0,400}?\\.map\\(\\([^)]*\\)\\s*=>\\s*\\(?\\s*<(\\w+)`,
      ).exec(codigo);
      if (elMap && NO_ES_LISTA.includes(elMap[1])) continue;

      /**
       * El otro recorte: una primitiva de `packages/ui` que recibe la colección
       * por prop.
       *
       * `DataTable` no puede escribir «qué va a aparecer acá»: no sabe qué son
       * sus filas. El vacío es de quien la usa, y la guarda lo pide ahí — es la
       * única excepción POR REGLA, y por eso va en el código y no en una lista.
       */
      const esPrimitivaDeUi = archivo.includes(`${'packages'}/ui/`) && !codigo.includes(`useState`);
      if (esPrimitivaDeUi) continue;

      hallazgos.push({ archivo, arreglo, silencioso: !declarado });
    }
  }
  return hallazgos.sort((a, b) =>
    a.archivo === b.archivo ? a.arreglo.localeCompare(b.arreglo) : a.archivo.localeCompare(b.archivo),
  );
}

export function pantallasQueDesaparecen(raices: string[]): PantallaQueDesaparece[] {
  const hallazgos: PantallaQueDesaparece[] = [];
  for (const archivo of raices.flatMap((r) => fuentes(r))) {
    const codigo = fuenteLimpia(readFileSync(archivo, 'utf8'));
    if (codigo.includes('Skeleton')) continue;

    // Los estados de DATOS: tipo que no es primitivo y admite null.
    const datos = new Set<string>();
    for (const m of codigo.matchAll(/const \[(\w+), set\w+\] = useState<([^>]*?)>/g)) {
      if (/null/.test(m[2]) && !PRIMITIVO.test(m[2])) datos.add(m[1]);
    }
    for (const dato of datos) {
      // La pantalla desaparece: `return null` gobernado por ese dato.
      const desaparece = new RegExp(
        `if \\([^)]*(?:${dato} === null|!${dato})[^)]*\\)\\s*return null`,
      ).test(codigo);
      if (desaparece) hallazgos.push({ archivo, dato });
    }
  }
  return hallazgos.sort((a, b) =>
    a.archivo === b.archivo ? a.dato.localeCompare(b.dato) : a.archivo.localeCompare(b.archivo),
  );
}
