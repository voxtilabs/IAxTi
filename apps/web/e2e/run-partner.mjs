// #56: navegador → API/JWT/RLS → BullMQ → Zavu y Secret Manager HTTP sintéticos.
// No se usan credenciales ni servicios externos. No acredita aceptación de Meta.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {cpSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHmac,randomUUID} from 'node:crypto';
import {SignJWT,exportJWK,generateKeyPair} from 'jose';
import {createPool,runMigrations,withTenant,permisosDelRol} from '@iaxti/db';
import {createInvitation,acceptInvitation} from '@iaxti/module-identity';
import {porQueNoCorrer} from './build-coherente.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const require=createRequire(join(root,'apps/api/package.json'));
const {createTenant}=require('@iaxti/module-organizations');
const {createGoogleSecretStore}=createRequire(join(root,'packages/modules/whatsapp/package.json'))('@iaxti/google');
const {partnerPorts,processPartnerInvitation}=require('@iaxti/module-whatsapp');
const {createModuleWorker,redisConnection}=require('@iaxti/core');
const ownerUrl=process.env.DATABASE_URL,appUrl=process.env.APP_DATABASE_URL;
const redisUrl=process.env.REDIS_URL;
if(!ownerUrl||!appUrl||!redisUrl)throw new Error('Configura DATABASE_URL, APP_DATABASE_URL y REDIS_URL de pruebas.');
const owner=new URL(ownerUrl),application=new URL(appUrl),queue=new URL(redisUrl);
const local=url=>['127.0.0.1','localhost','[::1]'].includes(url.hostname);
if(!local(owner)||!local(application)||!/^\/iaxti_test_[a-z0-9_]+$/.test(owner.pathname)||
 application.host!==owner.host||application.pathname!==owner.pathname||application.username!=='iaxti_app'||
 !local(queue)||queue.protocol!=='redis:'||!/^\/(?:[1-9]|1[0-5])$/.test(queue.pathname)){
 throw new Error('El arnés exige una base local iaxti_test_ compartida por dueño/iaxti_app y Redis local aislado (DB1–15).');
}
// CI puede recuperar todos los tests de caché: preparar la base/rol aquí evita
// depender de que otra suite los haya creado. Nunca altera un rol existente.
async function prepareDatabase(){
 const adminUrl=new URL(owner);adminUrl.pathname='/postgres';const admin=createPool(adminUrl.toString());
 try{
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='iaxti_app') THEN
   CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app' NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  const database=owner.pathname.slice(1);
  if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)await admin.query(`CREATE DATABASE "${database}"`);
 }finally{await admin.end();}
}
async function checkApplicationRole(){
 const connection=createPool(appUrl);
 try{
  const result=await permisosDelRol(connection);
  if(!result.listo)throw new Error('El rol iaxti_app de prueba no cumple RLS/permisos; no se modifica automáticamente.');
  console.log('partner e2e: rol iaxti_app verificado, sin BYPASSRLS y permisos completos.');
 }finally{await connection.end();}
}
const apiPort=4071,webPort=4072,fixturePort=4073,fixtureBase=`http://127.0.0.1:${fixturePort}`,issuer=`${fixtureBase}/auth/v1`;
const children=[],invitations=new Map(),senders=new Map(),secrets=new Map();
let app,fixture,worker,redis,db,failRotation=false,created=0,rotated=0;
const launch=(command,args,env,cwd=root)=>{const c=spawn(command,args,{cwd,stdio:'inherit',env:{...process.env,...env}});children.push(c);return c;};
async function ready(url){for(let i=0;i<60;i++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error('Servidor de prueba no disponible.');}
try{
 await prepareDatabase();
 const {publicKey,privateKey}=await generateKeyPair('ES256');const key={...await exportJWK(publicKey),alg:'ES256',kid:'partner-e2e'};
 fixture=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{},path=req.url;
   const send=(json,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(json));};
   if(path.startsWith('/auth/'))return send({keys:[key]});
   if(path==='/fixture/counts')return send({created,rotated});
   if(path==='/fixture/complete'){
    const inv=invitations.get(body.invitationId);if(!inv)return send({},404);
    const senderId=`snd_${randomUUID().replaceAll('-','')}`;
    Object.assign(inv,{status:'completed',senderId,connectedAccount:{channel:'whatsapp',id:`meta_${inv.id}`,name:'Número sintético'}});
    senders.set(senderId,{id:senderId,name:'Número sintético',channels:['whatsapp'],phoneNumber:'+56911111111',whatsapp:{phoneNumberId:`meta_${inv.id}`}});
    failRotation=body.failRotation===true;
    const event=JSON.stringify({id:`evt_${randomUUID().replaceAll('-','')}`,type:'invitation.status_changed',projectId:'project_synthetic',data:{invitationId:inv.id,currentStatus:'completed'}});
    const t=Math.floor(Date.now()/1000),signature=`t=${t},v2=${createHmac('sha256','synthetic_project_signature').update(`${t}.${event}`).digest('hex')}`;
    const r=await fetch(`http://127.0.0.1:${apiPort}/webhooks/zavu/invitations`,{method:'POST',headers:{'Content-Type':'application/json','X-Zavu-Signature':signature},body:event});
    return send({status:r.status});
   }
   if(req.headers.authorization!=='Bearer synthetic_key'&&!path.startsWith('/v1/projects/'))return send({},401);
   if(path==='/v1/me')return send({project:{id:'project_synthetic',name:'Proyecto sintético'},isTestMode:true});
   if(path==='/v1/invitations'&&req.method==='POST'){
    const id=`inv_${randomUUID().replaceAll('-','')}`,inv={id,url:`https://dashboard.zavu.dev/invite/${id}`,connectionType:'whatsapp_waba',status:'pending',expiresAt:new Date(Date.now()+86400000).toISOString(),senderId:null,connectedAccount:null};
    created++;invitations.set(id,inv);return send({invitation:inv},201);
   }
   if(path.startsWith('/v1/invitations/'))return send({invitation:invitations.get(path.split('/').at(-1))});
   if(path.startsWith('/v1/senders/')){
    const sender=senders.get(path.split('/')[3]);if(!sender)return send({},404);
    if(path.endsWith('/webhook/secret')){rotated++;if(failRotation){failRotation=false;res.destroy();return;}return send({secret:`synthetic_${sender.id}`});}
    if(req.method==='PATCH')sender.webhook={url:body.webhookUrl,active:body.webhookActive,events:body.webhookEvents};
    return send(sender);
   }
   if(path.startsWith('/v1/projects/')){
    if(req.headers.authorization!=='Bearer synthetic_adc')return send({},401);
    if(req.method==='POST'&&path.includes('?secretId='))return send({name:`projects/test-project/secrets/${new URL(`${fixtureBase}${path}`).searchParams.get('secretId')}`});
    const name=path.slice(4).replace(/:addVersion$|:access$/,'');
    if(path.endsWith(':addVersion')){secrets.set(`${name}/versions/1`,body.payload);return send({name:`${name}/versions/1`,state:'ENABLED'});}
    if(path.endsWith(':access'))return send({name,payload:secrets.get(name)});
    if(req.method==='DELETE'){for(const k of secrets.keys())if(k.startsWith(`${name}/versions/`))secrets.delete(k);return send({});}
   }
   send({},404);
  }catch{res.writeHead(500);res.end('{}');}
 });
 await new Promise(r=>fixture.listen(fixturePort,'127.0.0.1',r));
 db=createPool(ownerUrl);await runMigrations(db);const auth=[];
 for(const mode of ['dia','noche','recuperacion']){
  const userId=randomUUID(),tenant=await withTenant(db,randomUUID(),c=>createTenant(c,{name:`Negocio ficticio ${mode}`}));
  const invitation=await withTenant(db,tenant.id,c=>createInvitation(c,{tenantId:tenant.id,email:`${userId}@example.test`,roleName:'ADMIN'}));
  await withTenant(db,tenant.id,c=>acceptInvitation(c,{token:invitation.token,userId}));
  const accessToken=await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:key.kid}).setSubject(userId).setIssuer(issuer).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  auth.push({mode,userId,tenantId:tenant.id,accessToken});
 }
 await db.query('GRANT USAGE ON SCHEMA public TO iaxti_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO iaxti_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_app; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO iaxti_app; REVOKE UPDATE,DELETE ON audit_log,platform_audit FROM iaxti_app; REVOKE INSERT,UPDATE,DELETE ON schema_migrations FROM iaxti_app');
 await checkApplicationRole();
 writeFileSync(join(here,'.partner-auth.json'),JSON.stringify(auth));
 Object.assign(process.env,{DATABASE_URL:appUrl,REDIS_URL:redisUrl,SUPABASE_JWKS_URL:`${issuer}/.well-known/jwks.json`,IAXTI_ENV:'e2e',ZAVU_API_KEY:'synthetic_key',ZAVU_API_BASE:`${fixtureBase}/v1`,ZAVU_PARTNER_PROJECT_ID:'project_synthetic',ZAVU_PARTNER_API_URL:'https://api.example.test',ZAVU_PARTNER_WEBHOOK_SECRET:'synthetic_project_signature',ZAVU_ENVIOS_REALES:'0',GOOGLE_SECRET_PROJECT_ID:'test-project',GOOGLE_SECRET_LOCATION:'southamerica-west1'});
 const {createApp}=require(join(root,'apps/api/dist/main.js'));
 const {registry}=require(join(root,'apps/api/dist/registry.js'));
 const {PARTNER_HTTP}=require(join(root,'apps/api/dist/partner-invitations.controller.js'));
 const ports=partnerPorts(()=>registry.isActive('whatsapp')&&registry.isActive('channels'));
 ports.secrets=createGoogleSecretStore({projectId:'test-project',location:'southamerica-west1'},{accessToken:async()=>'synthetic_adc',fetch:async(url,init)=>{const u=new URL(String(url));if(u.origin!=='https://secretmanager.googleapis.com')throw new Error('No se permite red externa.');return fetch(`${fixtureBase}${u.pathname}${u.search}`,init);}});
 app=await createApp({rateLimitPerMinute:100000});const deps=app.get(PARTNER_HTTP);deps.ports=()=>ports;
 redis=redisConnection();worker=createModuleWorker('inbound',registry,async job=>{if(job.name!=='whatsapp.partner')throw new Error('Job ajeno al arnés.');return processPartnerInvitation(deps.pool(),job.data.tenantId,job.data.invitationId,ports);},redis);
 await app.listen(apiPort,'127.0.0.1');
 const web=join(root,'apps/web'),standalone=join(web,'.next/standalone/apps/web');
 const objection=porQueNoCorrer({delStandalone:readFileSync(join(standalone,'.next/BUILD_ID'),'utf8'),delNext:readFileSync(join(web,'.next/BUILD_ID'),'utf8')});if(objection)throw new Error(objection);
 rmSync(join(standalone,'.next/static'),{recursive:true,force:true});cpSync(join(web,'.next/static'),join(standalone,'.next/static'),{recursive:true});
 if(existsSync(join(web,'public')))cpSync(join(web,'public'),join(standalone,'public'),{recursive:true});
 launch('node',['server.js'],{NODE_ENV:'production',PORT:String(webPort),HOSTNAME:'127.0.0.1',API_URL_PUBLIC:`http://127.0.0.1:${apiPort}`,API_URL_INTERNAL:`http://127.0.0.1:${apiPort}`,SUPABASE_URL:fixtureBase,SUPABASE_ANON_KEY:'test-anon'},standalone);
 await ready(`http://127.0.0.1:${webPort}/login`);
 const pw=launch('pnpm',['exec','playwright','test','--config','playwright.partner.config.ts',...process.argv.slice(2)],{},web);
 process.exitCode=await new Promise(r=>pw.once('exit',code=>r(code??1)));
}catch(e){console.error(e instanceof Error?e.message:'Falló el arnés local.');process.exitCode=1;}
finally{for(const child of children)child.kill('SIGTERM');await worker?.close();await redis?.quit();await app?.close();await db?.end();fixture?.close();rmSync(join(here,'.partner-auth.json'),{force:true});}
// Nest crea pools/caches de proceso; este ejecutable no deja sus handles vivos.
process.exit(process.exitCode??0);
