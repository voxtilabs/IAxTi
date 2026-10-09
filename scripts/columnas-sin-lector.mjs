#!/usr/bin/env node
// Regenera la lista base de #703. Sin argumentos, muestra la diferencia.
//
// La lista es un TRINQUETE: la guarda falla si aparece una columna nueva sin
// lector, y falla pidiendo bajar la marca si una consigue lector y nadie la
// saca. Este script existe para que bajarla sea un comando y no una edición a
// mano — una lista que cuesta actualizar es una lista que se actualiza mal.
//
// Los MOTIVOS se conservan: son lo único de esta lista que no se puede
// derivar del código, y perderlos al regenerar haría que la lista se
// convirtiera en lo que las otras guardas ya son, una lista sin porqués.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { columnasSinLector } = require('../packages/core/dist/columnas-sin-lector.js');

const RUTA = 'docs/columnas-sin-lector.txt';
const SIN_MOTIVO = 'SIN MOTIVO — escribe acá por qué esta columna no se lee, o dale un lector.';

const texto = readFileSync(RUTA, 'utf8');
const cabecera = texto.split('\n').filter((l) => l.startsWith('#')).join('\n');
const motivos = new Map(
  texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [columna, ...resto] = l.split(' — ');
      return [columna.trim(), resto.join(' — ').trim()];
    }),
);

const ahora = columnasSinLector(['packages/modules'], ['packages', 'apps']);
const nuevas = ahora.filter((c) => !motivos.has(c));
const resueltas = [...motivos.keys()].filter((c) => !ahora.includes(c));

if (process.argv.includes('--escribir')) {
  const lineas = ahora.map((c) => `${c} — ${motivos.get(c) || SIN_MOTIVO}`);
  writeFileSync(RUTA, `${cabecera}\n\n${lineas.join('\n')}\n`);
  console.log(`${RUTA}: ${motivos.size} → ${ahora.length}`);
  if (nuevas.length) console.log('ESCRIBE EL MOTIVO de:\n  ' + nuevas.join('\n  '));
} else {
  console.log(`en la lista: ${motivos.size} · ahora: ${ahora.length}`);
  if (nuevas.length) console.log('NUEVAS sin lector:\n  ' + nuevas.join('\n  '));
  if (resueltas.length) console.log('YA TIENEN lector (baja la marca):\n  ' + resueltas.join('\n  '));
  if (!nuevas.length && !resueltas.length) console.log('sin cambios');
  if (nuevas.length || resueltas.length) process.exit(1);
}
