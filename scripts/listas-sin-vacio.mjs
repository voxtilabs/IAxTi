#!/usr/bin/env node
// Regenera la lista base de #588. Sin argumentos, muestra la diferencia.
//
// Mismo trinquete que #703: la guarda falla si aparece una colección nueva sin
// estado vacío, y falla pidiendo BAJAR la marca si una lo estrena y nadie la
// saca. Este script existe para que bajarla sea un comando y no una edición a
// mano — una lista que cuesta actualizar es una lista que se actualiza mal.
//
// ## Por qué esta lista NO lleva motivos y la de esqueletos sí
//
// Son 41 colecciones. A ese tamaño, escribir un motivo por entrada es trabajo
// sin valor por entrada: cuarenta y una líneas que dicen «falta» con palabras
// distintas, que nadie lee y que envejecen juntas. Lo mismo decidió #703 con
// sus 201 columnas.
//
// La de esqueletos son SEIS pantallas con nombre, y ahí el motivo es
// información que no está en ninguna otra parte —«esto es una búsqueda, no una
// colección» no se deduce del código—, así que va con motivo y en el test,
// como #447.
//
// La unidad es la COLECCIÓN y no el componente, y por eso este número (41) es
// mayor que el del issue (22): #588 contó componentes, y un componente puede
// dibujar tres listas o ninguna.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listasSinVacio } = require('../packages/core/dist/listas-sin-estados.js');

const RUTA = 'docs/listas-sin-vacio.txt';
const RAICES = ['apps/web/components', 'packages/ui/src/react'];

const entradas = listasSinVacio(RAICES).map(
  (l) => `${l.archivo.replace(/^apps\/web\/components\//, '').replace(/^packages\/ui\/src\/react\//, 'ui/')}#${l.arreglo}`,
);

const texto = readFileSync(RUTA, 'utf8');
const cabecera = texto.split('\n').filter((l) => l.startsWith('#')).join('\n');
const antes = texto
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

if (process.argv.includes('--escribir')) {
  writeFileSync(RUTA, `${cabecera}\n\n${entradas.join('\n')}\n`);
  console.log(`${RUTA}: ${antes.length} → ${entradas.length}`);
} else {
  const nuevas = entradas.filter((e) => !antes.includes(e));
  const resueltas = antes.filter((e) => !entradas.includes(e));
  console.log(`en la lista: ${antes.length} · ahora: ${entradas.length}`);
  for (const n of nuevas) console.log(`  NUEVA     ${n}`);
  for (const r of resueltas) console.log(`  RESUELTA  ${r}`);
  if (nuevas.length === 0 && resueltas.length === 0) console.log('sin cambios');
}
