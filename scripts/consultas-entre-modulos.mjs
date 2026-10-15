#!/usr/bin/env node
// Regenera la lista base de #784. Sin argumentos, muestra la diferencia.
//
// La lista es un TRINQUETE: la guarda falla si aparece un cruce nuevo de los
// que la regla no permite —leer tablas de un módulo que no declarás, o
// escribir en tablas ajenas aunque lo declares— y falla pidiendo bajar la
// marca si uno de los de la lista deja de hacerlo y nadie lo saca. Este script
// existe para que bajarla sea un comando y no una edición a mano — una lista
// que cuesta actualizar es una lista que se actualiza mal.
//
// Los MOTIVOS se conservan: son lo único de esta lista que no se puede derivar
// del código, y perderlos al regenerar la convertiría en lo que ya es un
// hallazgo del issue — una lista de pares sin porqués.
//
// Pero la llave de un motivo es el nombre COMPLETO de la entrada, tablas
// incluidas, así que ampliar un cruce a una tabla más no hereda el motivo
// viejo: se imprime para que quien amplía lo relea y lo edite. Esa es la
// diferencia entre conservar un porqué y arrastrarlo.
//
// Imprime siempre la medición del criterio 2 del issue —cuántas de las
// consultas que cruzan son escrituras— porque ese número es la razón por la
// que la regla quedó partida en dos mitades, y tiene que poder volver a
// sacarse en un comando y no de un comentario.
//
// Con `--detalle` imprime, por entrada, las tablas y los archivos medidos: es
// lo que hace falta para ESCRIBIR el motivo de una entrada nueva.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  crucesEntreModulos,
  crucesFueraDeLaRegla,
  duenosDeTabla,
  medicionDeCruces,
  nombreDelCruce,
  parDelCruce,
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
const ahora = crucesFueraDeLaRegla(cruces);
const fuera = cruces.filter((c) => !c.declarado || c.escribe);
const medicion = medicionDeCruces(cruces);

/** El criterio 2 del issue, en las dos unidades. */
const resumen =
  `${medicion.pares} pares cruzan · ${medicion.paresDeclarados} declarados · ` +
  `${medicion.paresQueEscriben} escriben\n` +
  `${medicion.consultas} consultas archivo-tabla cruzan · ${medicion.escrituras} son ESCRITURAS\n` +
  `${fuera.length} entradas en la lista (lectura sin declarar + toda escritura ajena)`;

if (process.argv.includes('--detalle')) {
  for (const cruce of fuera) {
    console.log(`\n${nombreDelCruce(cruce)}`);
    console.log(`  por qué: ${cruce.declarado ? 'escribe en tabla ajena' : 'no declara al dueño'}`);
    console.log(`  consultas: ${cruce.consultas} (${cruce.escrituras} escriben)`);
    console.log(`  archivos: ${cruce.archivos.join('\n            ')}`);
  }
  console.log(`\n${resumen}`);
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
// El motivo de la versión anterior del MISMO par, para cuando lo que cambió es
// el alcance (una tabla más) y no el cruce.
const porPar = new Map([...motivos].map(([nombre, motivo]) => [parDelCruce(nombre), motivo]));

const nuevos = ahora.filter((c) => !motivos.has(c));
const resueltos = [...motivos.keys()].filter((c) => !ahora.includes(c));

/** Lo que hay que releer antes de escribir el motivo de una entrada nueva. */
const antes = (nombre) => {
  const previo = porPar.get(parDelCruce(nombre));
  return previo ? `\n    antes decía: ${previo}` : '';
};

if (process.argv.includes('--escribir')) {
  const lineas = ahora.map((c) => `${c} — ${motivos.get(c) || SIN_MOTIVO}`);
  writeFileSync(RUTA, `${cabecera}\n\n${lineas.join('\n')}\n`);
  console.log(`${RUTA}: ${motivos.size} → ${ahora.length}`);
  if (nuevos.length)
    console.log('ESCRIBE EL MOTIVO de:\n  ' + nuevos.map((c) => c + antes(c)).join('\n  '));
} else {
  console.log(resumen);
  console.log(`en la lista: ${motivos.size} · ahora: ${ahora.length}`);
  if (nuevos.length)
    console.log('NUEVOS fuera de la regla:\n  ' + nuevos.map((c) => c + antes(c)).join('\n  '));
  if (resueltos.length) console.log('YA NO ESTÁN FUERA (baja la marca):\n  ' + resueltos.join('\n  '));
  if (!nuevos.length && !resueltos.length) console.log('sin cambios');
  if (nuevos.length || resueltos.length) process.exit(1);
}
