#!/usr/bin/env node
// Trinquete de #788: avisos que tiran el `code` y el `requestId` del error.
//
// `apiFetch` lanza un `ApiError` que trae `code` y `requestId`, y el repo
// tiene `avisoDe()` desde #659 justo para conservarlos. Guardar
// `err.message` pelado los tira: la pantalla dice «algo salió mal» y quien
// atiende no tiene qué pasarle a quien puede mirar los registros. Desde el
// celular —que es donde se usa la bandeja— tampoco hay consola del navegador
// donde ir a buscarlo.
//
// ## Por qué nace como trinquete y no en cero
//
// Porque hay 115. `avisoDe()` existe hace rato y casi nadie lo llama, que es
// exactamente lo que #788 dice: el camino existe y se usa a medias. Ponerlo
// en cero obligaría a tocar 115 sitios en un solo PR, que es la forma más
// segura de que nadie lo revise. La marca baja sola a medida que las
// pantallas se migran a `useCarga`.
//
// Falla en las dos direcciones, como los otros trinquetes del repo: si
// aparece uno nuevo, y si uno se arregla y nadie baja la marca. Lo segundo
// importa igual que lo primero — una lista que dice «falta» de algo ya hecho
// es un mapa viejo, y el próximo que la lea le va a creer.
//
// Con `--escribir` regenera la lista. Que bajarla sea un comando y no una
// edición a mano: una lista que cuesta actualizar se actualiza mal.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUTA = 'docs/avisos-sin-rastro.txt';
const RAICES = ['apps/web', 'apps/admin'];

// `setAviso(err.message)` y sus variantes: `(err as Error).message`,
// `e instanceof Error ? e.message : '...'`. Lo que se busca es que el texto
// del error entre al estado SIN su rastro.
//
// `setAviso(mensajeDeError(err))` cuenta igual (#1161). Esa función arregla la
// MITAD del problema —ya no muestra «The string did not match the expected
// pattern.», el mensaje crudo que tira WebKit— pero devuelve un `string`, así
// que el `code · requestId` se sigue perdiendo, que es de lo que habla este
// trinquete. Si no estuviera acá, migrar una pantalla a `mensajeDeError`
// bajaría la marca sin haber arreglado lo que la marca cuenta: el mapa diría
// «ya está» de 86 sitios donde no está.
const TIRA_EL_RASTRO = /set(?:Aviso|Error)\(\s*(?:mensajeDeError\(|\(?\s*\(?\s*(?:err|e|error)\b[^;]{0,40}?\.message)/;

// Las pruebas quedan fuera, y no por comodidad: varias AFIRMAN sobre el
// texto del código —`expect(HORARIOS).toContain('setAviso((err as
// Error).message)')`— para proteger que el motivo del rechazo lo ponga el
// servidor. Esa línea no es un aviso que tire el rastro, es una prueba
// hablando de uno. Contarla haría que migrar una pantalla subiera la marca en
// vez de bajarla, que es exactamente al revés.
function archivos(dir) {
  const salida = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === '.next' || entrada === 'dist') continue;
    if (entrada === 'tests' || entrada === 'e2e') continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (/\.tsx?$/.test(entrada)) salida.push(ruta);
  }
  return salida;
}

const ahora = [];
for (const raiz of RAICES) {
  for (const ruta of archivos(raiz)) {
    const lineas = readFileSync(ruta, 'utf8').split('\n');
    lineas.forEach((linea, i) => {
      if (TIRA_EL_RASTRO.test(linea)) ahora.push(`${ruta}:${i + 1}`);
    });
  }
}

const texto = readFileSync(RUTA, 'utf8');
const cabecera = texto.split('\n').filter((l) => l.startsWith('#')).join('\n');
const antes = texto
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

if (process.argv.includes('--escribir')) {
  writeFileSync(RUTA, `${cabecera}\n\n${ahora.join('\n')}\n`);
  console.log(`${RUTA}: ${antes.length} → ${ahora.length}`);
  process.exit(0);
}

console.log(`en la lista: ${antes.length} · ahora: ${ahora.length}`);

// Se compara por CANTIDAD y no por línea exacta a propósito: agregar una
// línea arriba de un archivo correría todos sus números y daría un rojo que
// no es un defecto. Lo que el trinquete protege es que el total no suba.
if (ahora.length > antes.length) {
  const nuevos = ahora.filter((a) => !antes.includes(a));
  console.error(
    `\nAparecieron avisos que tiran el \`code · requestId\` del error (#788):\n  ${nuevos.join('\n  ')}\n\n` +
      'Usá `avisoDe(err)` en vez de `err.message`, o `useCarga` si la pantalla\n' +
      'carga datos: conserva el identificador con el que se puede buscar en los\n' +
      'registros qué pasó. Sin él, la pantalla dice «quedó registrado» sin decir\n' +
      'con qué, y desde un teléfono no hay consola donde ir a mirar.',
  );
  process.exit(1);
}

if (ahora.length < antes.length) {
  console.error(
    `\nBajaron de ${antes.length} a ${ahora.length}: corré \`pnpm avisos --escribir\` y commiteá la lista.\n` +
      'Una lista que dice «falta» de algo ya hecho es un mapa viejo, y el\n' +
      'próximo que la lea le va a creer.',
  );
  process.exit(1);
}
console.log('sin cambios');
