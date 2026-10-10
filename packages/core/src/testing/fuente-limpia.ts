/**
 * Quitar los comentarios de un archivo fuente, una sola vez para todo el repo
 * (#569).
 *
 * ## Por qué existe
 *
 * Treinta archivos tenían su propia copia de esto, con variantes, y **el que la
 * escribe de nuevo se olvida de usarla**. Pasó tres veces en una semana, cada
 * vez con una guarda distinta y siempre igual: *la guarda se pone roja por el
 * comentario que la explica.*
 *
 *  - un `// #548` disparó el buscador de hex suelto —«548» son tres dígitos hex—;
 *  - un comentario que decía «no importa recharts» hizo fallar la comprobación
 *    de que ese archivo no importa recharts;
 *  - una nota que CITA el `Math.log10` que se borró hizo fallar la comprobación
 *    de que ya no está.
 *
 * Y el daño no es el falso positivo: es que **una guarda que grita de más se
 * apaga igual de rápido que una que no grita**. La primera vez se investiga; la
 * tercera se relaja la expresión; la quinta alguien la borra, y con ella se va
 * la comprobación de verdad. Peor: al ver una guarda roja por su propio
 * comentario, la reacción natural es «falso positivo, sigo» — y el día que sea
 * un positivo REAL con la misma forma, se va a leer igual.
 *
 * ## Por qué un recorrido y no una expresión regular
 *
 * Las treinta copias eran `replace(/\/\/.*$/gm, '')`, y eso parte al medio
 * cualquier `https://…` que haya en el código. Todavía no había molestado, pero
 * es justo la clase de cosa que hace desconfiar de la herramienta en el peor
 * momento. Una expresión regular no puede saber si un `//` está dentro de un
 * string: hay que recorrer el texto sabiendo dónde se está.
 *
 * ## Lo que conserva, y es lo que las copias rompían
 *
 * **La numeración de líneas.** Las copias partían el archivo y filtraban las
 * líneas de comentario, así que todo lo de abajo se corría de lugar y cualquier
 * guarda que reportara «línea 42» mentía. Acá el comentario se reemplaza por
 * espacios y los saltos de línea se mantienen: el texto limpio tiene exactamente
 * las mismas líneas que el original, en el mismo orden.
 *
 * ## Lo que NO hace
 *
 * No es un parser. No entiende JSX ni TypeScript: entiende strings, plantillas,
 * expresiones regulares y comentarios, que es lo que hace falta para que una
 * guarda de texto no se dispare sola. Convertirlas en guardas con AST sería
 * mejor y es otra conversación.
 */

/** Dónde estamos mientras recorremos el texto. */
type Estado =
  | 'codigo'
  | 'comilla-simple'
  | 'comilla-doble'
  | 'plantilla'
  | 'regex'
  | 'bloque'
  | 'linea';

/**
 * ¿Puede un `/` acá empezar una expresión regular, o es una división?
 *
 * La heurística de siempre: después de un valor —un identificador, un número,
 * un paréntesis o corchete que cierra— un `/` divide; en cualquier otro lugar
 * abre una expresión regular. No es perfecta (no lo es ninguna sin parsear),
 * pero cubre todo lo que este repositorio escribe, y el caso que importa es
 * `/\/\//` — una regex que contiene barras, que una copia ingenua destruía.
 */
function puedeAbrirRegex(anterior: string): boolean {
  if (anterior === '') return true;
  return !/[\w$)\]'"`]/.test(anterior);
}

/**
 * El mismo texto, con los comentarios cambiados por espacios.
 *
 * Quita comentarios de bloque (`/* … *\/`), de línea (`// …`) y los de JSX
 * (`{/* … *\/}`, incluidas las llaves, que si no quedan sueltas). Deja intacto
 * cualquier `//` o `/*` que viva dentro de un string, de una plantilla o de una
 * expresión regular.
 */
export function fuenteLimpia(texto: string): string {
  const salida: string[] = [];
  let estado: Estado = 'codigo';
  let i = 0;
  // Lo último que se vio en código, para decidir si un `/` abre regex.
  let anteriorEnCodigo = '';

  /** Un carácter que se borra: espacio, salvo el salto de línea. */
  const borrar = (c: string) => (c === '\n' ? '\n' : ' ');

  while (i < texto.length) {
    const c = texto[i];
    const d = texto[i + 1] ?? '';

    switch (estado) {
      case 'codigo': {
        // El comentario de JSX se trata completo —con sus llaves— porque
        // dejarlas sueltas convierte `{/* nota */}` en `{}`, y hay guardas que
        // cuentan llaves para encontrar el final de una llamada.
        if (c === '{') {
          const m = /^\{\s*\/\*[\s\S]*?\*\/\s*\}/.exec(texto.slice(i));
          if (m) {
            salida.push([...m[0]].map(borrar).join(''));
            i += m[0].length;
            continue;
          }
        }
        if (c === '/' && d === '*') {
          estado = 'bloque';
          salida.push('  ');
          i += 2;
          continue;
        }
        if (c === '/' && d === '/') {
          estado = 'linea';
          salida.push('  ');
          i += 2;
          continue;
        }
        if (c === '/' && puedeAbrirRegex(anteriorEnCodigo)) {
          estado = 'regex';
        } else if (c === "'") {
          estado = 'comilla-simple';
        } else if (c === '"') {
          estado = 'comilla-doble';
        } else if (c === '`') {
          estado = 'plantilla';
        }
        if (!/\s/.test(c)) anteriorEnCodigo = c;
        salida.push(c);
        i += 1;
        continue;
      }

      case 'bloque': {
        if (c === '*' && d === '/') {
          estado = 'codigo';
          salida.push('  ');
          i += 2;
          continue;
        }
        salida.push(borrar(c));
        i += 1;
        continue;
      }

      case 'linea': {
        if (c === '\n') {
          estado = 'codigo';
          salida.push('\n');
          i += 1;
          continue;
        }
        salida.push(' ');
        i += 1;
        continue;
      }

      case 'comilla-simple':
      case 'comilla-doble':
      case 'plantilla':
      case 'regex': {
        salida.push(c);
        if (c === '\\') {
          // Lo escapado va tal cual: un `\'` no cierra el string, y un `\/`
          // dentro de una regex no la termina.
          if (i + 1 < texto.length) salida.push(texto[i + 1]);
          i += 2;
          continue;
        }
        const cierra =
          (estado === 'comilla-simple' && c === "'") ||
          (estado === 'comilla-doble' && c === '"') ||
          (estado === 'plantilla' && c === '`') ||
          (estado === 'regex' && c === '/') ||
          // Un string de una línea que no se cerró: el salto de línea lo cierra.
          // Sin esto, una comilla suelta en un comentario —que ya se borró— o un
          // apóstrofo en prosa se comerían el resto del archivo.
          ((estado === 'comilla-simple' || estado === 'comilla-doble' || estado === 'regex') &&
            c === '\n');
        if (cierra) {
          estado = 'codigo';
          anteriorEnCodigo = c === '\n' ? anteriorEnCodigo : c;
        }
        i += 1;
        continue;
      }
    }
  }

  return salida.join('');
}
