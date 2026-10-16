// Derivado estructural, NO anonimización integral de Supabase ni autorización de tráfico.
import {randomUUID} from 'node:crypto';
import {readFile,open,link,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {catalog,schemas,fingerprint,hash,ident} from './catalog.mjs';
export const manifest=JSON.parse(await readFile(new URL('./schema-113.json',import.meta.url),'utf8'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class DrError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new DrError(code);};
export function localDatabase(value){
 let url;try{url=new URL(value);}catch{fail('DR_CONNECTION_INVALID');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/iaxti_dr_[a-z0-9_]+$/.test(url.pathname)||url.search||url.hash)fail('DR_LOCAL_QUARANTINE_REQUIRED');
 return url;
}
async function checkSchema(client,target=false){
 const allowed=target?manifest.import_schemas:Object.keys(manifest.source_schemas);
 if((await schemas(client)).some(s=>!allowed.includes(s)))fail('DR_SCHEMA_UNCLASSIFIED');
 const actual=await catalog(client);
 if(!equal(actual,manifest.schema))fail('DR_SCHEMA_UNSUPPORTED');
}
const columns=table=>manifest.tables[table].columns;
const fields=table=>Object.keys(columns(table)).filter(c=>columns(table)[c].action!=='generated');
function checkManifest(){
 if(hash(manifest.schema)!==manifest.schema_hash||manifest.schema.migrations.length!==113)fail('DR_MANIFEST_INVALID');
 if(!equal(Object.keys(manifest.tables).sort(),manifest.schema.relations.map(r=>r.name).sort()))fail('DR_MANIFEST_INVALID');
 if(!equal(manifest.insert_order.slice().sort(),Object.entries(manifest.tables).filter(([,r])=>r.action==='synthetic').map(([n])=>n).sort()))fail('DR_MANIFEST_INVALID');
 for(const [table,rule] of Object.entries(manifest.tables)){
  if(!['omit','synthetic','reseed'].includes(rule.action))fail('DR_MANIFEST_INVALID');
  if(!equal(Object.keys(rule.columns),manifest.schema.columns.filter(c=>c.table_name===table).map(c=>c.name)))fail('DR_MANIFEST_INVALID');
  for(const column of Object.values(rule.columns))if(!['omit','uuid','constant','label','ordinal','generated'].includes(column.action))fail('DR_MANIFEST_INVALID');
 }
}
checkManifest();
function validateRows(tables){
 if(!tables||!equal(Object.keys(tables),manifest.insert_order))fail('DR_ARTIFACT_INVALID');
 let count=0;
 const indexes=new Map();
 for(const table of manifest.insert_order){
  const rows=tables[table];if(!Array.isArray(rows))fail('DR_ARTIFACT_INVALID');count+=rows.length;
  if(count>manifest.limits.rows)fail('DR_SIZE_LIMIT');
  const seen=new Set();indexes.set(table,new Map());
  for(const [offset,row] of rows.entries()){
   if(!row||!equal(Object.keys(row),fields(table)))fail('DR_ARTIFACT_INVALID');
   for(const [name,rule] of Object.entries(columns(table))){
    const value=row[name],definition=manifest.schema.columns.find(c=>c.table_name===table&&c.name===name);
    if(rule.action==='uuid'){
     if(value===null&&!definition.required)continue;
     if(typeof value!=='string'||!UUID.test(value))fail('DR_ARTIFACT_INVALID');
    }else if(rule.action==='constant'&&!equal(value,rule.value))fail('DR_ARTIFACT_INVALID');
    else if(rule.action==='label'&&value!==rule.prefix+(offset+1))fail('DR_ARTIFACT_INVALID');
    else if(rule.action==='ordinal'&&value!==offset+1)fail('DR_ARTIFACT_INVALID');
   }
   const key=row.id??JSON.stringify(row);if(seen.has(key))fail('DR_DUPLICATE_ROW');seen.add(key);
   if(row.id)indexes.get(table).set(row.id,row);
  }
 }
 for(const table of manifest.insert_order)for(const row of tables[table]){
  for(const [name,rule] of Object.entries(columns(table)))if(rule.action==='uuid'&&name!=='id'&&row[name]!==null){
   const parent=indexes.get(rule.domain)?.get(row[name]);if(!parent)fail('DR_ORPHAN_REFERENCE');
   if(row.tenant_id&&parent.tenant_id&&row.tenant_id!==parent.tenant_id)fail('DR_TENANT_MISMATCH');
  }
 }
 // Las FK reales también se comprueban aquí, incluidas las compuestas.
 for(const fk of manifest.schema.foreignKeys){
  if(!tables[fk.table_name])continue;
  for(const row of tables[fk.table_name]){
   const values=fk.columns.map(c=>row[c]);if(values.some(v=>v===null))continue;
   if(fk.target_schema!=='public'||!tables[fk.target]?.some(parent=>fk.targets.every((col,i)=>parent[col]===values[i])))fail('DR_ORPHAN_REFERENCE');
  }
 }
 return count;
}
export function validateArtifact(artifact){
 if(!artifact||!equal(Object.keys(artifact),['format','schema_hash','source_fingerprint','disabled','tables','checksum'])||artifact.format!=='iaxti-dr-structural-v1'||artifact.schema_hash!==manifest.schema_hash||artifact.disabled!==true||!/^[0-9a-f]{64}$/.test(artifact.source_fingerprint))fail('DR_ARTIFACT_INVALID');
 if(hash(artifact.tables)!==artifact.checksum)fail('DR_CHECKSUM_MISMATCH');
 return validateRows(artifact.tables);
}
async function publish(file,artifact){
 const data=JSON.stringify(artifact);if(Buffer.byteLength(data)>manifest.limits.bytes)fail('DR_SIZE_LIMIT');
 const temporary=join(dirname(file),`.dr-${randomUUID()}.tmp`);let handle;
 try{
  handle=await open(temporary,'wx',0o600);await handle.writeFile(data+'\n');await handle.sync();await handle.close();handle=null;
  // link crea el destino completo y falla si existe; nunca sobrescribe una copia.
  await link(temporary,file);
 }catch{fail('DR_OUTPUT_FAILED');}finally{await handle?.close();await unlink(temporary).catch(()=>{});}
}
export async function exportDerived(pool,url,file){
 localDatabase(url);const client=await pool.connect().catch(()=>fail('DR_CONNECTION_FAILED'));let committed=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL search_path=pg_catalog,public');
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query('SET LOCAL row_security=off');
  if((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only!=='on')fail('DR_READ_ONLY_REQUIRED');
  await checkSchema(client);const source=await fingerprint(client),maps=new Map(),tables={};let total=0;
  const mapped=(domain,id)=>{if(id===null)return null;const key=domain+':'+id;if(!maps.has(key))maps.set(key,randomUUID());return maps.get(key);};
  for(const table of manifest.insert_order){
   // No se seleccionan nombres, contenido, JSON, fechas, importes ni secretos originales.
   const reads=Object.entries(columns(table)).filter(([,r])=>r.action==='uuid').map(([c])=>c);
   const order=reads.includes('id')?['id']:reads;
   const raw=(await client.query(`SELECT ${reads.map(ident).join(',')} FROM public.${ident(table)} ORDER BY ${order.map(ident).join(',')} LIMIT $1`,[manifest.limits.rows+1])).rows;
   total+=raw.length;if(total>manifest.limits.rows)fail('DR_SIZE_LIMIT');
   tables[table]=raw.map((row,offset)=>Object.fromEntries(fields(table).map(name=>{
    const rule=columns(table)[name];let value;
    if(rule.action==='uuid')value=mapped(rule.domain,row[name]);
    else if(rule.action==='constant')value=rule.value;
    else if(rule.action==='label')value=rule.prefix+(offset+1);
    else if(rule.action==='ordinal')value=offset+1;
    else fail('DR_MANIFEST_INVALID');
    return [name,value];
   })));
  }
  const artifact={format:'iaxti-dr-structural-v1',schema_hash:manifest.schema_hash,source_fingerprint:source,disabled:true,tables,checksum:hash(tables)};
  validateArtifact(artifact);await client.query('COMMIT');committed=true;
  await publish(file,artifact);return {tables:manifest.insert_order.length,rows:total,excluded_tables:Object.keys(manifest.tables).length-manifest.insert_order.length,disabled:true,sha256:hash(JSON.stringify(artifact)+'\n')};
 }catch(error){if(!committed)await client.query('ROLLBACK').catch(()=>{});throw error instanceof DrError?error:new DrError('DR_EXPORT_FAILED');}finally{client.release();}
}
async function readArtifact(file){
 try{
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat();if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>manifest.limits.bytes)fail('DR_PRIVATE_ARTIFACT_REQUIRED');
  const value=JSON.parse(await handle.readFile('utf8'));validateArtifact(value);return value;}finally{await handle.close();}
 }catch(error){throw error instanceof DrError?error:new DrError('DR_ARTIFACT_INVALID');}
}
async function checkEmptyTarget(client){
  // Solo destino recién migrado: se toleran las cuatro tablas sembradas por migraciones.
  const seeded=new Set(Object.keys(manifest.reference_rows));
  for(const {name} of manifest.schema.relations)if(name!=='schema_migrations'&&!seeded.has(name)){
   if((await client.query(`SELECT EXISTS(SELECT 1 FROM public.${ident(name)}) AS present`)).rows[0].present)fail('DR_TARGET_NOT_EMPTY');
  }
  for(const [table,rows] of Object.entries(manifest.reference_rows)){
   const stable=row=>Object.fromEntries(Object.entries(row).filter(([name])=>{const type=manifest.schema.columns.find(c=>c.table_name===table&&c.name===name).type;return name!=='id'&&!type.startsWith('timestamp');}).sort(([a],[b])=>a.localeCompare(b)));
   const actual=(await client.query(`SELECT * FROM public.${ident(table)}`)).rows.map(stable).map(JSON.stringify).sort();
   if(!equal(actual,rows.map(stable).map(JSON.stringify).sort()))fail('DR_TARGET_NOT_EMPTY');
  }
}
export async function importDerived(pool,url,file,control){
 localDatabase(url);if(!control)fail('DR_CONTROL_CONNECTION_REQUIRED');const artifact=await readArtifact(file),client=await pool.connect().catch(()=>fail('DR_CONNECTION_FAILED'));
 try{
  await client.query('BEGIN');await client.query('SET LOCAL search_path=pg_catalog,public');await client.query("SET LOCAL session_replication_role='origin'");await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL lock_timeout='2s'");
  if(await fingerprint(client)===artifact.source_fingerprint)fail('DR_SOURCE_EQUALS_TARGET');
  await checkSchema(client,true);
  await checkEmptyTarget(client);
  const database=(await client.query('SELECT current_database() AS name')).rows[0].name;
  // PostgreSQL exige cerrar admisión desde OTRA base. Autocommit hace el
  // cierre visible antes de cargar; ante fallo permanece en cuarentena.
  await client.query('COMMIT');
  await control.query(`ALTER DATABASE ${ident(database)} ALLOW_CONNECTIONS false`);
  await client.query('BEGIN');await client.query('SET LOCAL search_path=pg_catalog,public');await client.query("SET LOCAL session_replication_role='origin'");await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL lock_timeout='2s'");
  if((await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n!==0)fail('DR_TARGET_IN_USE');
  await checkSchema(client,true);await checkEmptyTarget(client);
  const all=manifest.schema.relations.filter(r=>r.name!=='schema_migrations').map(r=>`public.${ident(r.name)}`);
  await client.query(`TRUNCATE ${all.join(',')} RESTART IDENTITY`);
  for(const [table,rows] of Object.entries(manifest.reference_rows)){
   for(const row of rows){const names=Object.keys(row);await client.query(`INSERT INTO public.${ident(table)} (${names.map(ident).join(',')}) VALUES (${names.map((_,i)=>'$'+(i+1)).join(',')})`,names.map(name=>manifest.schema.columns.find(c=>c.table_name===table&&c.name===name).type==='jsonb'?JSON.stringify(row[name]):row[name]));}
  }
  for(const table of manifest.insert_order){
   const names=fields(table),sql=`INSERT INTO public.${ident(table)} (${names.map(ident).join(',')}) VALUES (${names.map((_,i)=>'$'+(i+1)).join(',')})`;
   for(const row of artifact.tables[table])await client.query(sql,names.map(name=>{
    const value=row[name],type=manifest.schema.columns.find(c=>c.table_name===table&&c.name===name).type;
    return type==='jsonb'?JSON.stringify(value):value;
   }));
  }
  // El trigger de mensajes toca tres fechas; restablecer constantes del manifiesto.
  await client.query("UPDATE public.conversations SET updated_at='2000-01-01T00:00:00Z',last_message_at=NULL,last_inbound_at=NULL");
  // Dejar la secuencia consistente aunque el destino permanezca inhabilitado.
  await client.query("SELECT setval(pg_get_serial_sequence('public.messages','seq'),GREATEST(COALESCE((SELECT max(seq) FROM public.messages),0),1),EXISTS(SELECT 1 FROM public.messages))");
  // Verificar el derivado persistido antes del COMMIT; triggers/constraints siguen activos.
  for(const table of manifest.insert_order){
   const result=(await client.query(`SELECT ${fields(table).map(ident).join(',')} FROM public.${ident(table)}`)).rows;
   const normalize=row=>Object.fromEntries(fields(table).map(name=>[name,row[name] instanceof Date?row[name].toISOString():columns(table)[name].action==='ordinal'?Number(row[name]):row[name]]));
   const actual=result.map(normalize).map(JSON.stringify).sort(),expected=artifact.tables[table].map(JSON.stringify).sort();
   if(!equal(actual,expected))fail('DR_IMPORT_INTEGRITY_FAILED');
  }
  for(const [table,rule] of Object.entries(manifest.tables))if(rule.action==='omit'&&table!=='schema_migrations'){
   if((await client.query(`SELECT EXISTS(SELECT 1 FROM public.${ident(table)}) AS present`)).rows[0].present)fail('DR_EXCLUDED_DATA_PRESENT');
  }
  for(const [table,rows] of Object.entries(manifest.reference_rows)){
   const normalize=row=>Object.fromEntries(Object.keys(rows[0]??{}).map(name=>[name,row[name] instanceof Date?row[name].toISOString():row[name]]));
   const actual=(await client.query(`SELECT * FROM public.${ident(table)}`)).rows.map(normalize).map(JSON.stringify).sort();
   if(!equal(actual,rows.map(JSON.stringify).sort()))fail('DR_IMPORT_INTEGRITY_FAILED');
  }
  await client.query('COMMIT');return {rows:validateArtifact(artifact),disabled:true,requires_new_synthetic_auth:true,requires_synthetic_files:true};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error instanceof DrError?error:new DrError('DR_IMPORT_FAILED');}finally{client.release();}
}
