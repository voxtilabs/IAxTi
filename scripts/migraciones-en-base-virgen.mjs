#!/usr/bin/env node
// ¿Las migraciones corren en orden sobre una base NUEVA? (#738)
//
// Por qué existe: una migración de `analytics` referenciaba `conversations`, y
// el runner aplica las migraciones en orden topológico de DEPENDENCIAS —
// `analytics` no depende de `conversations`, así que sus migraciones corrían
// antes de que la tabla existiera. CI lo cazó con «relation "conversations"
// does not exist» y en local pasaba verde, porque la base de desarrollo ya tiene
// todas las tablas de corridas anteriores.
//
// Es una diferencia que `antes-de-empujar.sh` no podía ver por construcción. Esto
// la ve: crea una base vacía, corre TODAS las migraciones y la borra.
//
// Uso: node scripts/migraciones-en-base-virgen.mjs
//   DATABASE_URL tiene que apuntar a un Postgres donde se pueda crear una base.
import { createRequire } from 'node:module';

// El `require` se ancla en `packages/db/package.json` para resolver `pg` desde
// ahí; los módulos propios van por su ruta absoluta, porque relativa se
// resolvería contra ese ancla y no contra este archivo.
const dbPkg = new URL('../packages/db/package.json', import.meta.url);
const require = createRequire(dbPkg);
const { Pool } = require('pg');
const { createPool } = require(new URL('../packages/db/dist/client.js', import.meta.url).pathname);
const { runMigrations } = require(new URL('../packages/db/dist/migrate.js', import.meta.url).pathname);

const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const base = `iaxti_virgen_${process.pid}`;
const admin = new Pool({ connectionString: url });

let salida = 0;
try {
  await admin.query(`CREATE DATABASE ${base}`);
  const limpia = createPool(url.replace(/\/[^/?]+(\?|$)/, `/${base}$1`));
  try {
    const aplicadas = await runMigrations(limpia);
    console.log(`migraciones aplicadas sobre una base nueva: ${aplicadas.length}`);
  } finally {
    await limpia.end();
  }
} catch (err) {
  console.error(`FALLÓ sobre una base nueva: ${err.message}`);
  console.error(
    'Suele ser una migración que referencia una tabla de otro módulo: el runner\n' +
      'aplica en orden topológico de dependencias, así que la tabla puede no existir\n' +
      'todavía. La función o el índice van en el módulo DUEÑO de la tabla.',
  );
  salida = 1;
} finally {
  // La base de prueba se borra pase lo que pase: dejarla sería basura que se
  // acumula en cada corrida, y hay una guarda que caza justamente eso.
  await admin.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`).catch(() => {});
  await admin.end();
}
process.exit(salida);
