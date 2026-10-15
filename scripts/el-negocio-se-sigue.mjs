#!/usr/bin/env node
// Guarda de #789: pantallas que leen el negocio una vez y no vuelven a mirar.
//
// `useEffect(() => setTenant(selectedTenant()), [])` corre UNA vez al montar.
// Dos cosas salen mal con eso:
//
// 1. Si `localStorage` todavía no tiene el negocio en ese instante —primer
//    login, o la carrera entre el montaje y el selector— `tenant` se queda en
//    `null` PARA SIEMPRE. No hay segunda oportunidad y nada lo despierta: la
//    sección no aparece nunca en esa sesión.
// 2. Al CAMBIAR de negocio en el selector, la pantalla sigue mostrando los
//    datos del anterior hasta que alguien recargue la página. Eso es peor que
//    un hueco: son los datos de otro cliente bajo el nombre del nuevo.
//
// Y `const tenant = selectedTenant()` en el cuerpo del componente tampoco:
// leer `localStorage` durante el render desajusta la hidratación —el servidor
// no lo tiene y dibuja una cosa, el cliente lo lee y dibuja otra—. Lo probé
// escribiéndolo así primero, en #788.
//
// `useSelectedTenant()` resuelve las dos: escucha `iaxti-tenant-changed`, que
// es el evento que el selector dispara también en la misma pestaña.
//
// ## Esta nace en CERO, a diferencia del trinquete de avisos
//
// Porque se puede: eran 25 pantallas con el efecto y 4 lecturas en render, y
// el cambio es de una línea y siempre el mismo. Un trinquete se justifica
// cuando arreglar todo de una vez no se puede revisar; acá sí.
//
// Lo que NO se marca: `selectedTenant()` dentro de un manejador de eventos.
// Ahí se lee en el momento de la acción, así que siempre es el valor vigente
// —`preferencias-avisos` lo usa para armar la cabecera de un `fetch`— y
// obligarlo al hook sería cambiar algo correcto por algo igual con más pasos.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RAICES = ['apps/web'];
// El propio `tenant-switcher` es donde vive el hook: ahí la lectura es la
// implementación, no el defecto.
const DUENO_DEL_HOOK = /tenant-switcher\.tsx$/;

function archivos(dir) {
  const salida = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === '.next' || entrada === 'dist') continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (/\.tsx?$/.test(entrada)) salida.push(ruta);
  }
  return salida;
}

const hallazgos = [];
for (const raiz of RAICES) {
  for (const ruta of archivos(raiz)) {
    if (DUENO_DEL_HOOK.test(ruta)) continue;
    const lineas = readFileSync(ruta, 'utf8').split('\n');
    lineas.forEach((linea, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return;
      if (/useEffect\(\(\)\s*=>\s*setTenant\(selectedTenant\(\)\)/.test(linea)) {
        hallazgos.push(`${ruta}:${i + 1} — lee el negocio una vez y no vuelve a mirar`);
      }
      /**
       * Una asignación en el CUERPO del componente, y eso se discrimina por
       * indentación: exactamente dos espacios.
       *
       * No es una elegancia — es la diferencia entre un defecto y el uso
       * correcto. A cuatro espacios o más la lectura está dentro de un
       * manejador o de un efecto, y ahí leerla directo es lo que corresponde:
       * se lee en el momento de la acción, así que es el valor vigente. Una de
       * esas lecturas incluso tiene su motivo escrito al lado
       * (`agente-general`: «el tenant se lee al abrir... puede cambiar con el
       * selector sin que este componente se vuelva a montar»).
       *
       * Marcar las 17 que están a cuatro espacios habría mandado a «arreglar»
       * código correcto, que es la forma de que una guarda se desactive.
       *
       * El repo está formateado con Prettier, así que la indentación es
       * fiable. Si alguna vez deja de serlo, esto hay que leerlo con el AST,
       * como hace la guarda de rutas.
       */
      if (/^ {2}const\s+\w+\s*=\s*selectedTenant\(\)\s*;?\s*$/.test(linea)) {
        hallazgos.push(`${ruta}:${i + 1} — lee \`localStorage\` durante el render`);
      }
    });
  }
}

if (hallazgos.length > 0) {
  console.error('Pantallas que no siguen al selector de negocio (#789):\n');
  for (const h of hallazgos) console.error(`  ${h}`);
  console.error(
    '\nUsá `useSelectedTenant()`: escucha `iaxti-tenant-changed`, así que la\n' +
      'pantalla sigue al selector y no se queda sin negocio si `localStorage`\n' +
      'todavía no lo tenía al montar. Leerlo en un efecto con `[]` deja los datos\n' +
      'del negocio ANTERIOR a la vista al cambiar; leerlo en el render desajusta\n' +
      'la hidratación.\n' +
      'Dentro de un manejador de eventos, `selectedTenant()` suelto está bien:\n' +
      'ahí se lee en el momento de la acción.',
  );
  process.exit(1);
}
console.log('el-negocio-se-sigue: todas usan el hook');
