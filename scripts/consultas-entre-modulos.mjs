#!/usr/bin/env node
// Regenera la lista base de #784. Sin argumentos, muestra la diferencia.
//
// La lista es un TRINQUETE: la guarda falla si aparece un par nuevo que
// consulta tablas de un módulo que no declara, y falla pidiendo bajar la marca
// si uno de los de la lista deja de hacerlo y nadie lo saca. Este script
// existe para que bajarla sea un comando y no una edición a mano — una lista
// que cuesta actualizar es una lista que se actualiza mal.
//
// Los MOTIVOS se conservan: son lo único de esta lista que no se puede derivar
// del código, y perderlos al regenerar la convertiría en lo que ya es un
// hallazgo del issue — una lista de pares sin porqués.
//
// Con `--detalle` imprime, por par, las tablas y los archivos medidos: es lo
// que hace falta para ESCRIBIR el motivo de una entrada nueva.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  crucesEntreModulos,
  crucesSinDeclarar,
  duenosDeTabla,
  nombreDelCruce,
} = require('../packages/core/dist/consultas-entre-modulos.js');
const { findModulesDir, loadAllManifests } = require('../packages/core/dist/manifest.js');

const RUTA = 'docs/consultas-entre-modulos.txt';
const SIN_MOTIVO =
  'SIN MOTIVO — escribe acá por qué este cruce no pasa por el manifiesto, o declaralo en depends_on.';

const MODULOS = findModulesDir();
const modulos = loadAllManifests(MODULOS).map((m) => ({
  id: m.module.id,
  dir: join(MODULOS, m.module.id),
  declaradas: [...(m.depends_on?.required ?? []), ...(m.depends_on?.optional ?? [])],
}));
const cruces = crucesEntreModulos(modulos, duenosDeTabla(MODULOS));
// La misma función que usa la guarda: el día que el criterio cambie, no puede
// cambiar en un lado y no en el otro.
const ahora = crucesSinDeclarar(cruces);
const sinDeclarar = cruces.filter((c) => !c.declarado);

if (process.argv.includes('--detalle')) {
  for (const cruce of sinDeclarar) {
    console.log(`\n${nombreDelCruce(cruce)}`);
    console.log(`  tablas:   ${cruce.tablas.join(', ')}`);
    console.log(`  archivos: ${cruce.archivos.join('\n            ')}`);
  }
  console.log(
    `\n${cruces.length} pares cruzan · ${cruces.length - sinDeclarar.length} declarados · ` +
      `${sinDeclarar.length} sin declarar`,
  );
  process.exit(0);
}

const texto = readFileSync(RUTA, 'utf8');
const cabecera = texto.split('\n').filter((l) => l.startsWith('#')).join('\n');
const motivos = new Map(
  texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [par, ...resto] = l.split(' — ');
      return [par.trim(), resto.join(' — ').trim()];
    }),
);

const nuevos = ahora.filter((c) => !motivos.has(c));
const resueltos = [...motivos.keys()].filter((c) => !ahora.includes(c));

if (process.argv.includes('--escribir')) {
  const lineas = ahora.map((c) => `${c} — ${motivos.get(c) || SIN_MOTIVO}`);
  writeFileSync(RUTA, `${cabecera}\n\n${lineas.join('\n')}\n`);
  console.log(`${RUTA}: ${motivos.size} → ${ahora.length}`);
  if (nuevos.length) console.log('ESCRIBE EL MOTIVO de:\n  ' + nuevos.join('\n  '));
} else {
  console.log(`en la lista: ${motivos.size} · ahora: ${ahora.length} · pares que cruzan: ${cruces.length}`);
  if (nuevos.length) console.log('NUEVOS sin declarar:\n  ' + nuevos.join('\n  '));
  if (resueltos.length) console.log('YA NO CRUZAN sin declarar (baja la marca):\n  ' + resueltos.join('\n  '));
  if (!nuevos.length && !resueltos.length) console.log('sin cambios');
  if (nuevos.length || resueltos.length) process.exit(1);
}
