import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {manifest,localDatabase,validateArtifact} from './transformer.mjs';
import {hash} from './catalog.mjs';
const empty=()=>{const tables=Object.fromEntries(manifest.insert_order.map(t=>[t,[]]));return {format:'iaxti-dr-structural-v1',schema_hash:manifest.schema_hash,source_fingerprint:'a'.repeat(64),disabled:true,tables,checksum:hash(tables)};};
test('catálogo cerrado: 113 migraciones, 96 tablas, 915 columnas; cobertura explícita completa',()=>{
 assert.equal(manifest.schema.migrations.length,113);assert.equal(manifest.schema.relations.length,96);assert.equal(manifest.schema.columns.length,915);
 assert.equal(hash(manifest.schema),manifest.schema_hash);assert.equal(manifest.insert_order.length,12);
 for(const r of manifest.schema.relations)assert.deepEqual(Object.keys(manifest.tables[r.name].columns),manifest.schema.columns.filter(c=>c.table_name===r.name).map(c=>c.name));
 assert.equal(manifest.source_schemas.auth,'omit_entire_schema_without_reading_rows');assert.equal(manifest.source_schemas.storage,'omit_entire_schema_without_reading_rows');
});
test('rechaza hosts remotos, nombres no cuarentena y parámetros de conexión',()=>{
 for(const url of ['postgres://x:synthetic-secret@remote/iaxti_dr_test','postgres://x@localhost/iaxti','postgres://x@localhost/iaxti_dr_test?options=a','https://localhost/iaxti_dr_test'])assert.throws(()=>localDatabase(url));
 assert.equal(localDatabase('postgres://x@127.0.0.1:55432/iaxti_dr_test').pathname,'/iaxti_dr_test');
});
test('artefacto no admite extras, contenido, salida activa ni checksum inválido',()=>{
 assert.equal(validateArtifact(empty()),0);
 for(const edit of [a=>a.extra='raw',a=>a.disabled=false,a=>a.tables.messages.push({body:'PRIVATE'}),a=>a.checksum='0']){const a=empty();edit(a);assert.throws(()=>validateArtifact(a));}
});
test('CLI no imprime URL ni contraseña en errores',()=>{
 const result=spawnSync(process.execPath,['scripts/dr/cli.mjs','export','/tmp/never-created.json'],{encoding:'utf8',env:{...process.env,DR_SOURCE_URL:'postgres://tester:DO-NOT-PRINT-THIS@remote/iaxti_dr_test'}});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/DR_LOCAL_QUARANTINE_REQUIRED/);assert.doesNotMatch(result.stderr,/DO-NOT-PRINT-THIS|postgres:\/\//);
});
