#!/usr/bin/env node
// Regenera la lista base de #664. Sin argumentos, muestra la diferencia.
//
// La lista es un TRINQUETE: la guarda falla si aparece un export nuevo sin
// consumidor, y falla pidiendo bajar la marca si se quita uno. Este script
// existe para que bajarla sea un comando y no una edición a mano — una lista
// que cuesta actualizar es una lista que se actualiza mal.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { exportsSinConsumidor } = require('../packages/core/dist/exports-sin-consumidor.js');

const RUTA = 'docs/exports-sin-consumidor.txt';
const CABECERA = `# Exports de contrato sin un solo consumidor fuera de su módulo (#664).
#
# Esta lista es un TRINQUETE, no una lista de tareas: la guarda falla si
# aparece uno nuevo, y falla pidiendo bajar la marca si se quita uno. No
# afirma que este estado esté bien — impide que empeore.
#
# Se regenera con: node scripts/exports-sin-consumidor.mjs --escribir
`;

const ahora = exportsSinConsumidor(['apps', 'packages']);
const antes = readFileSync(RUTA, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const nuevos = ahora.filter((x) => !antes.includes(x));
const resueltos = antes.filter((x) => !ahora.includes(x));

if (process.argv.includes('--escribir')) {
  writeFileSync(RUTA, `${CABECERA}\n${ahora.join('\n')}\n`);
  console.log(`${RUTA}: ${antes.length} → ${ahora.length}`);
} else {
  console.log(`en la lista: ${antes.length} · ahora: ${ahora.length}`);
  if (nuevos.length) console.log('NUEVOS sin consumidor:\n  ' + nuevos.join('\n  '));
  if (resueltos.length) console.log('YA TIENEN consumidor (baja la marca):\n  ' + resueltos.join('\n  '));
  if (!nuevos.length && !resueltos.length) console.log('sin cambios');
}
