// SOLO clúster local desechable. Crea y elimina únicamente bases con sufijo propio.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,stat,rm,access,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {manifest,exportDerived,importDerived,validateArtifact} from './transformer.mjs';
import {hash,ident,catalog} from './catalog.mjs';
const {Pool}=createRequire(new URL('../../packages/db/package.json',import.meta.url))('pg');
const adminUrl=new URL(process.env.DR_TEST_ADMIN_URL??'');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname));assert.equal(adminUrl.pathname,'/postgres');
const schemaRoot=resolve(process.env.DR_TEST_SCHEMA_ROOT??'.');
const {runMigrations}=createRequire(join(schemaRoot,'packages/db/package.json'))('./dist/migrate.js');
const admin=new Pool({connectionString:adminUrl.href,max:2});
const prefix='iaxti_dr_test_'+randomUUID().replaceAll('-','').slice(0,10),dbs=[],pools=[];let template,source,artifact,file,dir,originalIds=[];
async function database(name,clone=true){const db=prefix+'_'+name;await admin.query(`CREATE DATABASE ${ident(db)}${clone?' TEMPLATE '+ident(template):''}`);dbs.push(db);const url=new URL(adminUrl);url.pathname='/'+db;const pool=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:2000});pools.push(pool);return {db,url:url.href,pool};}
async function insert(pool,table,row){const names=Object.keys(row);await pool.query(`INSERT INTO public.${ident(table)} (${names.map(ident)}) VALUES (${names.map((_,i)=>'$'+(i+1))})`,names.map(n=>manifest.schema.columns.find(c=>c.table_name===table&&c.name===n)?.type==='jsonb'?JSON.stringify(row[n]):row[n]));}
const code=expected=>error=>{assert.equal(error.code,expected);return true;};
const noFile=async path=>assert.rejects(access(path));
before(async()=>{
 dir=await mkdtemp(join(tmpdir(),'iaxti-dr-'));const t=await database('template',false);template=t.db;
 await runMigrations(t.pool,join(schemaRoot,'packages/modules'));assert.deepEqual(await catalog(t.pool),manifest.schema);await t.pool.end();pools.splice(pools.indexOf(t.pool),1);
 source=await database('source');
 for(let i=0;i<2;i++){
  const ids=Object.fromEntries(manifest.insert_order.filter(t=>t!=='contact_tags').map(t=>[t,randomUUID()]));originalIds.push(...Object.values(ids));
  for(const table of manifest.insert_order){const row={};for(const [name,r] of Object.entries(manifest.tables[table].columns)){
   if(r.action==='generated')continue;
   row[name]=r.action==='uuid'?ids[r.domain]:r.action==='constant'?r.value:r.action==='label'?'SOURCE-PRIVATE-'+table+i:i+1;
  }
  // Marcadores ficticios: nunca se usan clientes, credenciales ni backups reales.
  if(table==='tenants'){row.name='SENSITIVE-TENANT-'+i;row.settings={token:'SENSITIVE-JSON-TOKEN'};row.state='active';}
  if(table==='contacts'){row.email='sensitive@example.invalid';row.phone='+56912345678';row.custom={secret:'SENSITIVE-CONTACT'};}
  if(table==='companies')row.custom={rut:'SENSITIVE-RUT'};
  if(table==='messages'){row.body='SENSITIVE-MESSAGE';row.meta={prompt:'SENSITIVE-PROMPT'};row.attachments=[{url:'https://private.example.invalid/SENSITIVE-FILE'}];row.transcription='SENSITIVE-AUDIO';row.provider_message_id='SENSITIVE-EXTERNAL-'+i;}
  if(table==='deals')row.value=987654.32;
  if(table==='activities')row.body='SENSITIVE-NOTE';
  await insert(source.pool,table,row);
  }
  await source.pool.query("INSERT INTO audit_log(tenant_id,actor,actor_kind,action,resource,result,hash,metadata) VALUES($1,'SENSITIVE-ACTOR','user','read','contacts','success','SENSITIVE-HASH','{\"pii\":\"SENSITIVE-AUDIT\"}')",[ids.tenants]);
  await source.pool.query("INSERT INTO outbox(name,tenant_id,payload) VALUES('SENSITIVE-EVENT',$1,'{\"token\":\"SENSITIVE-JOB\"}')",[ids.tenants]);
  await source.pool.query("INSERT INTO api_keys(tenant_id,name,key_hash) VALUES($1,'SENSITIVE-KEY',$2)",[ids.tenants,'SENSITIVE-HASH-'+i]);
  await source.pool.query("INSERT INTO channel_accounts(tenant_id,kind,name,config) VALUES($1,'whatsapp','SENSITIVE-ACCOUNT','{\"secretRef\":\"projects/private/secrets/SENSITIVE\"}')",[ids.tenants]);
  await source.pool.query("INSERT INTO invitations(tenant_id,role_name,token,email) VALUES($1,'ADMIN',$2,'sensitive@example.invalid')",[ids.tenants,'SENSITIVE-INVITATION-'+i]);
 }
 await source.pool.query("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid,email text,encrypted_password text); INSERT INTO auth.users VALUES(gen_random_uuid(),'SENSITIVE-AUTH','SENSITIVE-PASSWORD'); CREATE SCHEMA storage;CREATE TABLE storage.objects(path text);INSERT INTO storage.objects VALUES('SENSITIVE-STORAGE')");
 file=join(dir,'derived.json');await exportDerived(source.pool,source.url,file);artifact=JSON.parse(await readFile(file,'utf8'));
});
after(async()=>{for(const p of pools)await p.end();for(const db of dbs.reverse()){await admin.query(`ALTER DATABASE ${ident(db)} ALLOW_CONNECTIONS true`);await admin.query(`DROP DATABASE ${ident(db)} WITH(FORCE)`);}await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});
test('exportación real: no valores originales, IDs nuevos, fuente intacta y archivo 0600',async()=>{
 const text=await readFile(file,'utf8');assert.doesNotMatch(text,/SENSITIVE|example\.invalid|56912345678|987654/);for(const id of originalIds)assert.ok(!text.includes(id));
 assert.equal((await stat(file)).mode&0o777,0o600);assert.equal(validateArtifact(artifact),24);
 assert.equal((await source.pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n,2);
 assert.equal((await source.pool.query("SELECT body FROM messages LIMIT 1")).rows[0].body,'SENSITIVE-MESSAGE');
 const second=join(dir,'second.json');await exportDerived(source.pool,source.url,second);assert.notEqual((JSON.parse(await readFile(second,'utf8'))).tables.tenants[0].id,artifact.tables.tenants[0].id);
 await assert.rejects(exportDerived(source.pool,source.url,file),code('DR_OUTPUT_FAILED'));assert.equal(await readFile(file,'utf8'),text);
});
test('importación real: FK, valores exactos, datos excluidos vacíos, secuencia y cierre de conexiones',async()=>{
 const target=await database('success');const result=await importDerived(target.pool,target.url,file,admin);assert.equal(result.rows,24);assert.equal(result.disabled,true);
 assert.deepEqual((await target.pool.query('SELECT DISTINCT state FROM tenants')).rows,[{state:'suspended'}]);
 assert.equal((await target.pool.query('SELECT count(*)::int n FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id JOIN contacts x ON x.id=c.contact_id AND x.tenant_id=c.tenant_id')).rows[0].n,2);
 for(const [t,r] of Object.entries(manifest.tables))if(r.action==='omit'&&t!=='schema_migrations')assert.equal((await target.pool.query(`SELECT count(*)::int n FROM ${ident(t)}`)).rows[0].n,0,t);
 assert.equal((await target.pool.query("SELECT nextval(pg_get_serial_sequence('messages','seq'))::int n")).rows[0].n,3);
 const probe=new Pool({connectionString:target.url});try{await assert.rejects(probe.query('SELECT 1'),e=>e.code==='55000');}finally{await probe.end();}
 assert.deepEqual((await target.pool.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('auth','storage')")).rows,[]);
});
test('source=target se rechaza sin tocar la fuente',async()=>{await assert.rejects(importDerived(source.pool,source.url,file,admin),code('DR_SOURCE_EQUALS_TARGET'));assert.equal((await source.pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,2);});
test('rol sujeto a RLS se rechaza, nunca exporta un éxito vacío',async()=>{
 const role=prefix+'_reader';await admin.query(`CREATE ROLE ${ident(role)} NOLOGIN`);
 try{await source.pool.query(`GRANT USAGE ON SCHEMA public TO ${ident(role)};GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ident(role)};GRANT EXECUTE ON FUNCTION pg_control_system() TO ${ident(role)}`);
 const wrapped={connect:async()=>{const c=await source.pool.connect();await c.query(`SET ROLE ${ident(role)}`);return {query:(...a)=>c.query(...a),release:()=>{c.query('RESET ROLE').finally(()=>c.release());}};}};
 const path=join(dir,'rls.json');await assert.rejects(exportDerived(wrapped,source.url,path));await noFile(path);
 }finally{await source.pool.query(`DROP OWNED BY ${ident(role)}`);await admin.query(`DROP ROLE ${ident(role)}`);}
});
test('fuente realmente READ ONLY y SELECT de negocio limitado a UUID',async()=>{
 const seen=[];const wrapped={connect:async()=>{const c=await source.pool.connect();return {query:async(sql,args)=>{seen.push(sql);if(sql.startsWith('SELECT "id"')&&sql.includes('FROM public.')){assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');assert.doesNotMatch(sql,/"body"|"settings"|"meta"|"email"|"created_at"/);}return c.query(sql,args);},release:()=>c.release()};}};
 await exportDerived(wrapped,source.url,join(dir,'readonly.json'));assert.equal(seen.filter(s=>s.includes(' LIMIT $1')).length,12);assert.ok(seen.includes('SET LOCAL row_security=off'));
});
for(const [kind,add,remove] of [
 ['columna', 'ALTER TABLE contacts ADD COLUMN secret_new text','ALTER TABLE contacts DROP COLUMN secret_new'],
 ['tabla', 'CREATE TABLE new_unknown(payload text)','DROP TABLE new_unknown'],
 ['vista','CREATE VIEW secret_view AS SELECT email FROM contacts','DROP VIEW secret_view'],
 ['schema','CREATE SCHEMA surprise','DROP SCHEMA surprise'],
 ['policy','CREATE POLICY surprise ON contacts USING(true)','DROP POLICY surprise ON contacts'],
 ['RLS','ALTER TABLE contacts DISABLE ROW LEVEL SECURITY','ALTER TABLE contacts ENABLE ROW LEVEL SECURITY'],
 ['trigger','ALTER TABLE messages DISABLE TRIGGER USER','ALTER TABLE messages ENABLE TRIGGER USER'],
 ['FK interna','ALTER TABLE contacts DISABLE TRIGGER ALL','ALTER TABLE contacts ENABLE TRIGGER ALL'],
 ])test('rechaza '+kind+' desconocido/cambiado sin publicar',async()=>{await source.pool.query(add);const path=join(dir,kind+'.json');try{await assert.rejects(exportDerived(source.pool,source.url,path));await noFile(path);}finally{await source.pool.query(remove);}});
test('destino con contenido o catálogo global modificado no se destruye',async()=>{
 const target=await database('occupied');await target.pool.query("UPDATE roles SET permissions='[\"SENSITIVE-TARGET\"]' WHERE name='ADMIN'");
 await assert.rejects(importDerived(target.pool,target.url,file,admin),code('DR_TARGET_NOT_EMPTY'));assert.equal((await target.pool.query("SELECT permissions FROM roles WHERE name='ADMIN'")).rows[0].permissions[0],'SENSITIVE-TARGET');
});
test('otra sesión bloquea la carga, cierre confirmado y datos intactos',async()=>{
 const target=await database('busy'),other=new Pool({connectionString:target.url});await other.query('SELECT 1');
 try{await assert.rejects(importDerived(target.pool,target.url,file,admin),code('DR_TARGET_IN_USE'));assert.equal((await target.pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,0);assert.equal((await admin.query('SELECT datallowconn FROM pg_database WHERE datname=$1',[target.db])).rows[0].datallowconn,false);}finally{await other.end();}
});
test('fallo a mitad revierte toda carga y permanece bloqueado sin exponer error',async()=>{
 const target=await database('rollback');const wrapped={connect:async()=>{const c=await target.pool.connect();return {query:(sql,args)=>{if(sql.startsWith('INSERT INTO public."messages"'))throw Error('postgres://SENSITIVE:password@remote');return c.query(sql,args);},release:()=>c.release()};}};
 await assert.rejects(importDerived(wrapped,target.url,file,admin),code('DR_IMPORT_FAILED'));assert.equal((await target.pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,0);assert.equal((await target.pool.query('SELECT count(*)::int n FROM roles')).rows[0].n,4);assert.equal((await admin.query('SELECT datallowconn FROM pg_database WHERE datname=$1',[target.db])).rows[0].datallowconn,false);
});
test('artefactos manipulados, symlink y permisos abiertos no llegan al destino',async()=>{
 const target=await database('tamper');const bad=structuredClone(artifact);bad.tables.messages[0].body='SENSITIVE';bad.checksum=hash(bad.tables);const path=join(dir,'tampered.json');await writeFile(path,JSON.stringify(bad),{mode:0o600});await assert.rejects(importDerived(target.pool,target.url,path,admin),code('DR_ARTIFACT_INVALID'));
 const cross=structuredClone(artifact);const other=cross.tables.conversations.find(c=>c.tenant_id!==cross.tables.messages[0].tenant_id);assert.ok(other);cross.tables.messages[0].conversation_id=other.id;cross.checksum=hash(cross.tables);await writeFile(path,JSON.stringify(cross));await assert.rejects(importDerived(target.pool,target.url,path,admin),code('DR_TENANT_MISMATCH'));
 const sym=join(dir,'symlink.json');await symlink(file,sym);await assert.rejects(importDerived(target.pool,target.url,sym,admin),code('DR_ARTIFACT_INVALID'));
 await chmod(path,0o644);await assert.rejects(importDerived(target.pool,target.url,path,admin),code('DR_PRIVATE_ARTIFACT_REQUIRED'));assert.equal((await target.pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,0);
});
test('revalida después del cierre: una inserción entre precheck y ALTER no se trunca',async()=>{
 const target=await database('race');let inserted=false;
 const control={query:async(sql)=>{if(sql.startsWith('ALTER DATABASE')){const other=new Pool({connectionString:target.url});try{await other.query("INSERT INTO tenants(name) VALUES('SENSITIVE-CONCURRENT')");inserted=true;}finally{await other.end();}}return admin.query(sql);}};
 await assert.rejects(importDerived(target.pool,target.url,file,control),code('DR_TARGET_NOT_EMPTY'));assert.ok(inserted);assert.equal((await target.pool.query('SELECT name FROM tenants')).rows[0].name,'SENSITIVE-CONCURRENT');
});
test('base de 97 migraciones rechazada explícitamente; no compatibilidad inventada',async()=>{
 const base=await database('base97',false);await runMigrations(base.pool,resolve('packages/modules'));assert.equal((await base.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,97);
 const path=join(dir,'old-schema.json');await assert.rejects(exportDerived(base.pool,base.url,path),code('DR_SCHEMA_UNSUPPORTED'));await noFile(path);
});
test('sesión replica heredada no omite triggers/constraints del importador',async()=>{
 const target=await database('replica');await target.pool.query("SET session_replication_role='replica'");await importDerived(target.pool,target.url,file,admin);assert.equal((await target.pool.query('SELECT count(*)::int n FROM messages')).rows[0].n,2);
});
test('pg desconectado mientras idle: subproceso falla con código fijo, sin volcar client/secret',async()=>{
 const program=`import {createRequire} from 'node:module';import {watchPool} from './scripts/dr/pool-safety.mjs';const {Pool}=createRequire(new URL('./packages/db/package.json',import.meta.url))('pg');const p=new Pool({connectionString:process.env.DR_IDLE_URL}),a=new Pool({connectionString:process.env.DR_TEST_ADMIN_URL});let done;const interrupted=new Promise(r=>done=r);const check=watchPool(p,code=>{console.error(code);process.exitCode=1;done();});try{const pid=(await p.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await a.query('SELECT pg_terminate_backend($1)',[pid]);await interrupted;try{check();console.log('WRONG-SUCCESS');}catch{}}finally{await p.end();await a.end();}`;
 const child=spawn(process.execPath,['--input-type=module','-e',program],{env:{...process.env,DR_IDLE_URL:source.url},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);const exit=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});assert.equal(exit,1);assert.equal(stdout,'');assert.equal(stderr.trim(),'DR_CONNECTION_INTERRUPTED');assert.doesNotMatch(stderr,/postgres:\/\/|connectionParameters|password|iaxti/);
});

test('FK internas desactivadas en destino rechazan antes de truncar',async()=>{
 const target=await database('disabled_fk');await target.pool.query('ALTER TABLE contacts DISABLE TRIGGER ALL');await assert.rejects(importDerived(target.pool,target.url,file,admin),code('DR_SCHEMA_UNSUPPORTED'));assert.equal((await target.pool.query('SELECT count(*)::int n FROM roles')).rows[0].n,4);
});
