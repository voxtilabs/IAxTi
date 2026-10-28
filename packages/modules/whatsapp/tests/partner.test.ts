import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {createPool,runMigrations,withTenant,estadoRls} from '@iaxti/db';
import {escrituraCaida} from '@iaxti/core/testing';
import {createTenant,changeTenantState} from '@iaxti/module-organizations';
import {setChannelState,getChannelAccount,createChannelAccount,copyChannelWebhookSecret,reservarEmisor,cuentaDelEmisor} from '@iaxti/module-channels';
import {createGoogleSecretStore} from '@iaxti/google';
import {partnerPorts,resolveChannelWebhookSecret,type PartnerPorts} from '../application/partner-provider';
import {startPartnerInvitation,partnerStatus,receivePartnerWebhook,processPartnerInvitation,resumePartnerInvitation,cleanupPartnerSecrets,maintainPartnerInvitations} from '../application/partner-invitations';

let owner:Pool,safe:Pool,server:Server,ports:PartnerPorts;
const role=`partner_${randomUUID().replaceAll('-','')}`;
const remote=new Map<string,Record<string,unknown>>();
const senders=new Map<string,Record<string,unknown>>();
const secrets=new Map<string,{data:string;dataCrc32c:string}>();
const calls:Array<{path:string;method:string;body:Record<string,unknown>}>=[];
let loseCreate=false,loseRotation=false,failSecret=false,wrongPhone=false;
const projectId='project_synthetic';
beforeAll(async()=>{
 owner=createPool(process.env.DATABASE_URL!);await runMigrations(owner);
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
 await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
 await owner.query(`REVOKE UPDATE,DELETE ON audit_log FROM ${role}`);
 await owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
 safe=createPool(process.env.DATABASE_URL!.replace(/\/\/[^@]+@/,`//${role}:${role}@`));
 server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  const path=req.url!;const method=req.method!;calls.push({path,method,body});
  const send=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/v1/me')return send({project:{id:projectId,name:'Proyecto sintético'},isTestMode:true});
  if(path==='/v1/invitations'&&method==='POST'){
   const id=`inv_${randomUUID().replaceAll('-','')}`;
   const invitation={id,url:`https://dashboard.zavu.dev/invite/${id}`,connectionType:'whatsapp_waba',status:'pending',expiresAt:new Date(Date.now()+86400000).toISOString(),senderId:null,connectedAccount:null};remote.set(id,invitation);
   if(loseCreate){loseCreate=false;res.destroy();return;}
   return send({invitation},201);
  }
  if(path.startsWith('/v1/invitations/'))return send({invitation:remote.get(path.split('/').at(-1)!)});
  if(path.startsWith('/v1/senders/')){
   const id=path.split('/')[3]!;const sender=senders.get(id);
   if(!sender)return send({},404);
   if(path.endsWith('/webhook/secret')){if(loseRotation){loseRotation=false;res.destroy();return;}return send({secret:`synthetic_${id}`});}
   if(method==='PATCH'){sender.webhook={url:body.webhookUrl,active:body.webhookActive,events:body.webhookEvents};return send(sender);}
   return send(wrongPhone?{...sender,whatsapp:{phoneNumberId:'another_meta_number'}}:sender);
  }
  if(path.startsWith('/v1/projects/')){
   if(method==='POST'&&path.includes('?secretId=')){const id=new URL(`http://test${path}`).searchParams.get('secretId');return send({name:`projects/test-project/secrets/${id}`});}
   const name=path.slice(4).replace(/:addVersion$|:access$/,'');
   if(path.endsWith(':addVersion')){if(failSecret)return send({},503);secrets.set(`${name}/versions/1`,body.payload as {data:string;dataCrc32c:string});return send({name:`${name}/versions/1`,state:'ENABLED'});}
   if(path.endsWith(':access')){const payload=secrets.get(name);return send(payload?{name,payload}:{},payload?200:404);}
   if(method==='DELETE'){for(const ref of secrets.keys())if(ref.startsWith(`${name}/versions/`))secrets.delete(ref);return send({});}
  }
  send({},404);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 for(const [k,v]of Object.entries({ZAVU_PARTNER_PROJECT_ID:projectId,ZAVU_PARTNER_API_URL:'https://api.example.test',ZAVU_PARTNER_WEBHOOK_SECRET:'synthetic_project_signature',ZAVU_API_KEY:'synthetic_key',ZAVU_API_BASE:`${base}/v1`,GOOGLE_SECRET_PROJECT_ID:'test-project',GOOGLE_SECRET_LOCATION:'southamerica-west1',IAXTI_ENV:'test',ZAVU_ENVIOS_REALES:'0'}))vi.stubEnv(k,v);
 ports=partnerPorts(()=>true);
 ports.secrets=createGoogleSecretStore({projectId:'test-project',location:'southamerica-west1'},{accessToken:async()=>'synthetic_adc',fetch:async(url,init)=>{const parsed=new URL(String(url));if(parsed.origin!=='https://secretmanager.googleapis.com')throw new Error('external access forbidden');return fetch(`${base}${parsed.pathname}${parsed.search}`,init);}});
},60000);
afterAll(async()=>{vi.unstubAllEnvs();await new Promise<void>(r=>server.close(()=>r()));await safe.end();await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);await owner.end();});
async function begin(){const tenant=await withTenant(owner,randomUUID(),c=>createTenant(c,{name:'Negocio ficticio'}));const actor={tenantId:tenant.id,actor:randomUUID(),actorKind:'user' as const,key:randomUUID()};const state=await startPartnerInvitation(safe,actor,ports);return {tenant:tenant.id,actor,state};}
async function row(t:string){return (await owner.query('SELECT * FROM whatsapp_partner_invitations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1',[t])).rows[0];}
async function complete(t:string){const r=await row(t);const inv=remote.get(r.invitation_id)!;const senderId=`snd_${randomUUID().replaceAll('-','')}`;Object.assign(inv,{status:'completed',senderId,connectedAccount:{channel:'whatsapp',id:`meta_${r.invitation_id}`,name:'Negocio ficticio'}});senders.set(senderId,{id:senderId,name:'Negocio ficticio',channels:['whatsapp'],phoneNumber:'+56911111111',whatsapp:{phoneNumberId:`meta_${r.invitation_id}`}});return r;}
function event(invitationId:string,extra:Record<string,unknown>={}){return JSON.stringify({id:`evt_${randomUUID().replaceAll('-','')}`,type:'invitation.status_changed',projectId,data:{invitationId,currentStatus:'completed'},...extra});}
function signature(raw:string){const t=Math.floor(Date.now()/1000);return `t=${t},v2=${createHmac('sha256',ports.config.projectWebhookSecret).update(`${t}.${raw}`).digest('hex')}`;}
async function deliver(t:string,procesaCon:Pool=safe){const r=await row(t);const raw=event(r.invitation_id);const job=await receivePartnerWebhook(safe,raw,signature(raw),ports);await processPartnerInvitation(procesaCon,t,job.invitationId,ports);return job;}

it('puerto HTTP real crea una vez bajo 6 solicitudes; solo correlación y refs quedan en SQL',async()=>{
 const tenant=await withTenant(owner,randomUUID(),c=>createTenant(c,{name:'Concurrente ficticio'}));const before=calls.filter(x=>x.path==='/v1/invitations').length;
 const actor={tenantId:tenant.id,actor:randomUUID(),actorKind:'user' as const,key:randomUUID()};
 await Promise.all(Array.from({length:6},()=>startPartnerInvitation(safe,actor,ports)));
 expect(calls.filter(x=>x.path==='/v1/invitations').length-before).toBe(1);
 const r=await row(tenant.id);expect(r.phase).toBe('pending');expect(JSON.stringify(r)).not.toContain('https://dashboard');
 const status=await partnerStatus(safe,tenant.id,ports,actor);expect(status.url).toMatch(/^https:\/\/dashboard.zavu.dev\/invite\//);
 expect((await owner.query("SELECT actor FROM audit_log WHERE tenant_id=$1 AND action='whatsapp.invitation.link_accessed' ORDER BY occurred_at DESC LIMIT 1",[tenant.id])).rows[0].actor).toBe(actor.actor);
 expect(calls.find(x=>x.path==='/v1/invitations')!.body).toEqual({clientName:'Concurrente ficticio',connectionType:'whatsapp_waba'});
});
it('completed firmado → cuenta connecting → secreto SM y GET confirmado → active + audit/outbox, duplicado no rota',async()=>{
 const x=await begin();const r=await complete(x.tenant);const job=await deliver(x.tenant);const result=await row(x.tenant);
 expect(result.phase).toBe('active');const account=await withTenant(safe,x.tenant,c=>getChannelAccount(c,x.tenant,result.account_id));expect(account.state).toBe('active');expect(account.webhookSecretRef).toMatch(/^sm:projects\/test-project/);
 expect(await resolveChannelWebhookSecret(account,ports.secrets)).toBe(`synthetic_${result.sender_id}`);
 expect((await owner.query("SELECT * FROM outbox WHERE tenant_id=$1 AND name='channel.connected'",[x.tenant])).rows).toHaveLength(1);
 const rotations=calls.filter(c=>c.path.endsWith('/webhook/secret')).length;
 await processPartnerInvitation(safe,x.tenant,job.invitationId,ports);await deliver(x.tenant);
 expect(calls.filter(c=>c.path.endsWith('/webhook/secret'))).toHaveLength(rotations);
 expect((await owner.query('SELECT * FROM whatsapp_numbers WHERE tenant_id=$1',[x.tenant])).rows).toHaveLength(1);
 expect(JSON.stringify((await owner.query('SELECT metadata FROM audit_log WHERE tenant_id=$1',[x.tenant])).rows)).not.toContain('synthetic_');
 expect((await row(x.tenant)).invitation_id).toBe(r.invitation_id);
});
it('respuesta create perdida queda ambigua: ni reintento ni nueva key repiten POST',async()=>{
 loseCreate=true;const x=await begin();expect(x.state.phase).toBe('ambiguous');const count=calls.filter(x=>x.path==='/v1/invitations').length;
 await startPartnerInvitation(safe,{...x.actor,key:randomUUID()},ports);expect(calls.filter(x=>x.path==='/v1/invitations')).toHaveLength(count);
 await expect(resumePartnerInvitation(safe,{...x.actor,id:x.state.id!},ports)).rejects.toMatchObject({code:'PARTNER_UNCERTAIN'});
});
it('HMAC/proyecto equivocado y evento anterior a correlación no crean cuentas',async()=>{
 const x=await begin();const r=await row(x.tenant);const raw=event(r.invitation_id);
 await expect(receivePartnerWebhook(safe,raw,'t=1,v2=bad',ports)).rejects.toMatchObject({status:401});
 const wrong=event(r.invitation_id,{projectId:'other'});await expect(receivePartnerWebhook(safe,wrong,signature(wrong),ports)).rejects.toMatchObject({status:400});
 const early=event('inv_not_committed');await expect(receivePartnerWebhook(safe,early,signature(early),ports)).rejects.toMatchObject({status:503});
 expect((await owner.query('SELECT * FROM channel_accounts WHERE tenant_id=$1',[x.tenant])).rows).toHaveLength(0);
});
it('RLS real y referencias de otra cuenta no acceden al almacén',async()=>{
 const a=await begin(),b=await begin();expect((await estadoRls(safe)).seSalta).toBe(false);
 expect((await safe.query('SELECT * FROM whatsapp_partner_invitations')).rows).toHaveLength(0);
 await expect(withTenant(safe,b.tenant,c=>c.query('UPDATE whatsapp_partner_invitations SET tenant_id=$2 WHERE tenant_id=$1',[b.tenant,a.tenant]))).rejects.toThrow();
 const refs=await owner.query('SELECT url_ref FROM whatsapp_partner_invitations WHERE tenant_id=$1',[a.tenant]);
 await owner.query('UPDATE whatsapp_partner_invitations SET url_ref=$2 WHERE tenant_id=$1',[b.tenant,refs.rows[0].url_ref]);
 await expect(partnerStatus(safe,b.tenant,ports,b.actor)).rejects.toMatchObject({code:'PARTNER_LINK_UNAVAILABLE'});
 expect(await resolveChannelWebhookSecret({tenantId:b.tenant,id:randomUUID(),webhookSecretRef:`sm:${refs.rows[0].url_ref}`},ports.secrets)).toBeUndefined();
});
it.each(['rotation','custody'])('fallo %s no activa ni reintenta rotación por callback; recuperación humana reanuda',async(kind)=>{
 const x=await begin();await complete(x.tenant);loseRotation=kind==='rotation';failSecret=kind==='custody';await deliver(x.tenant);failSecret=false;
 let r=await row(x.tenant);expect(r.phase).toBe('recovery_required');expect((await owner.query('SELECT state FROM channel_accounts WHERE id=$1',[r.account_id])).rows[0].state).toBe('connecting');
 const rotations=calls.filter(c=>c.path.endsWith('/webhook/secret')).length;await deliver(x.tenant);expect(calls.filter(c=>c.path.endsWith('/webhook/secret'))).toHaveLength(rotations);
 await resumePartnerInvitation(safe,{...x.actor,id:r.id},ports);await processPartnerInvitation(safe,x.tenant,r.id,ports);r=await row(x.tenant);expect(r.phase).toBe('active');
 await owner.query("UPDATE whatsapp_partner_secrets SET created_at=now()-interval '1 hour' WHERE tenant_id=$1",[x.tenant]);
 await cleanupPartnerSecrets(safe,x.tenant,ports);const account=await withTenant(safe,x.tenant,c=>getChannelAccount(c,x.tenant,r.account_id));expect(await resolveChannelWebhookSecret(account,ports.secrets)).toBe(`synthetic_${r.sender_id}`);
});
it('Meta phoneNumberId sustituido se rechaza antes de crear cuenta/configurar webhook',async()=>{
 const x=await begin();await complete(x.tenant);wrongPhone=true;
 try{await expect(deliver(x.tenant)).rejects.toMatchObject({code:'PARTNER_SENDER_INVALID'});}finally{wrongPhone=false;}
 expect((await owner.query('SELECT * FROM channel_accounts WHERE tenant_id=$1',[x.tenant])).rows).toHaveLength(0);
});
it('sin evento de expiración retira enlace, audita y deja crear otro intento',async()=>{
 const x=await begin();await owner.query("UPDATE whatsapp_partner_invitations SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",[x.tenant]);
 expect(await partnerStatus(safe,x.tenant,ports,x.actor)).toMatchObject({phase:'checking_expiry',url:null});
 const r=await row(x.tenant);remote.get(r.invitation_id)!.expiresAt=new Date(Date.now()-1000).toISOString();
 await processPartnerInvitation(safe,x.tenant,r.id,ports);
 expect((await partnerStatus(safe,x.tenant,ports,x.actor)).phase).toBe('expired');
 expect((await owner.query("SELECT destroy_pending FROM whatsapp_partner_secrets WHERE tenant_id=$1 AND purpose='url'",[x.tenant])).rows.every(r=>r.destroy_pending)).toBe(true);
 const next=await startPartnerInvitation(safe,{...x.actor,key:randomUUID()},ports);expect(next.id).not.toBe(x.state.id);expect(next.phase).toBe('pending');
});
it('suspensión/módulo off y desconexión no se revierten por callback tardío',async()=>{
 const x=await begin();await complete(x.tenant);await withTenant(safe,x.tenant,c=>changeTenantState(c,x.tenant,'read_only'));
 await expect(deliver(x.tenant)).rejects.toMatchObject({code:'TENANT_READ_ONLY'});
 expect((await owner.query('SELECT * FROM channel_accounts WHERE tenant_id=$1',[x.tenant])).rows).toHaveLength(0);
 const y=await begin();await complete(y.tenant);await expect(processPartnerInvitation(safe,y.tenant,y.state.id!,{...ports,enabled:()=>false})).rejects.toMatchObject({code:'MODULE_DISABLED'});
 await deliver(y.tenant);const r=await row(y.tenant);await withTenant(safe,y.tenant,c=>setChannelState(c,{tenantId:y.tenant,accountId:r.account_id,state:'disconnected'}));await deliver(y.tenant);
 expect((await owner.query('SELECT state FROM channel_accounts WHERE id=$1',[r.account_id])).rows[0].state).toBe('disconnected');expect((await partnerStatus(safe,y.tenant,ports)).phase).toBe('disconnected');
});
it('fallo audit tras activar remoto revierte active/refs/outbox; retry exige recuperación, cleanup no toca refs activas',async()=>{
 const x=await begin();await complete(x.tenant);
 await deliver(x.tenant,escrituraCaida(safe,{tabla:'audit_log',cuandoLosValoresIncluyan:'whatsapp.invitation.connected'}));
 // Y la auditoría de esa acción NO quedó escrita, que es el invariante: si el
 // desvío dejara de calzar, esto se pone rojo en vez de pasar por la razón
 // equivocada.
 expect((await owner.query("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='whatsapp.invitation.connected'",[x.tenant])).rowCount).toBe(0);
 const r=await row(x.tenant);expect(r.phase).toBe('recovery_required');expect((await owner.query('SELECT state,webhook_secret_ref FROM channel_accounts WHERE id=$1',[r.account_id])).rows[0]).toEqual({state:'connecting',webhook_secret_ref:'ZAVU_PARTNER_PENDING'});
 expect((await owner.query("SELECT * FROM outbox WHERE tenant_id=$1 AND name='channel.connected'",[x.tenant])).rows).toHaveLength(0);
});
it('crash durable previo a create/provision pasa a estado incierto; el barrido no repite escrituras remotas',async()=>{
 const x=await begin();await owner.query("UPDATE whatsapp_partner_invitations SET phase='creating',updated_at=now()-interval '3 minutes' WHERE tenant_id=$1",[x.tenant]);
 const before=calls.filter(x=>x.method==='POST'&&x.path==='/v1/invitations').length;
 await maintainPartnerInvitations(safe,ports);expect((await row(x.tenant)).phase).toBe('ambiguous');expect(calls.filter(x=>x.method==='POST'&&x.path==='/v1/invitations')).toHaveLength(before);
});
it('cleanup entre intención URL y custodia impide put huérfano; revisar recupera el mismo enlace',async()=>{
 const tenant=await withTenant(owner,randomUUID(),c=>createTenant(c,{name:'Carrera de custodia ficticia'}));
 const actor={tenantId:tenant.id,actor:randomUUID(),actorKind:'user' as const,key:randomUUID()};
 let triggered=false;
 const delayed=new Proxy(safe,{get(target,key){if(key!=='connect')return Reflect.get(target,key,target);return async()=>{
  const client=await safe.connect();let intent=false;
  return new Proxy(client,{get(target,key){if(key!=='query')return Reflect.get(target,key,target);return async(...args:Parameters<typeof client.query>)=>{
   const sql=String(args[0]);const result=await client.query(...args);
   if(sql.startsWith('INSERT INTO whatsapp_partner_secrets'))intent=true;
   if(sql==='COMMIT'&&intent&&!triggered){triggered=true;await owner.query("UPDATE whatsapp_partner_secrets SET created_at=now()-interval '1 hour' WHERE tenant_id=$1",[tenant.id]);await cleanupPartnerSecrets(safe,tenant.id,ports);}
   return result;
  };}});
 };}}) as Pool;
 const puts=calls.filter(x=>x.path.endsWith(':addVersion')).length;
 await expect(startPartnerInvitation(delayed,actor,ports)).rejects.toMatchObject({code:'PARTNER_LINK_UNAVAILABLE'});
 expect(triggered).toBe(true);expect(calls.filter(x=>x.path.endsWith(':addVersion'))).toHaveLength(puts);
 expect((await row(tenant.id)).url_ref).toBeNull();
 const current=await row(tenant.id);await resumePartnerInvitation(safe,{...actor,id:current.id},ports);await processPartnerInvitation(safe,tenant.id,current.id,ports);
 expect((await partnerStatus(safe,tenant.id,ports,actor)).url).toContain(current.invitation_id);
});

it('completed anterior al vencimiento con callback tardío prevalece sobre snapshot pending vencido',async()=>{
 const x=await begin();await owner.query("UPDATE whatsapp_partner_invitations SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",[x.tenant]);
 expect((await partnerStatus(safe,x.tenant,ports,x.actor)).phase).toBe('checking_expiry');
 const r=await complete(x.tenant);remote.get(r.invitation_id)!.expiresAt=new Date(Date.now()-1000).toISOString();
 await deliver(x.tenant);expect((await row(x.tenant)).phase).toBe('active');
});
it('reenvío oficial failed→pending sustituye enlace viejo y retira solo su secreto',async()=>{
 const x=await begin();const before=await row(x.tenant);const inv=remote.get(before.invitation_id)!;
 inv.status='failed';await deliver(x.tenant);
 inv.status='pending';inv.url=`https://dashboard.zavu.dev/invite/resent_${randomUUID().replaceAll('-','')}`;await deliver(x.tenant);
 const after=await row(x.tenant);expect(after.url_ref).not.toBe(before.url_ref);
 expect((await partnerStatus(safe,x.tenant,ports,x.actor)).url).toBe(inv.url);
 expect((await owner.query('SELECT destroy_pending FROM whatsapp_partner_secrets WHERE version_ref=$1',[before.url_ref])).rows[0].destroy_pending).toBe(true);
});

it('cancelled reenviada vuelve a pending con nueva URL; si existe otro intento no lo sustituye',async()=>{
 const x=await begin();const r=await row(x.tenant);const inv=remote.get(r.invitation_id)!;
 inv.status='cancelled';await deliver(x.tenant);expect((await row(x.tenant)).phase).toBe('cancelled');
 inv.status='pending';inv.url=`https://dashboard.zavu.dev/invite/reissued_${randomUUID().replaceAll('-','')}`;await deliver(x.tenant);
 expect((await partnerStatus(safe,x.tenant,ports,x.actor)).url).toBe(inv.url);
 inv.status='cancelled';await deliver(x.tenant);
 const next=await startPartnerInvitation(safe,{...x.actor,key:randomUUID()},ports);expect(next.id).not.toBe(r.id);
 inv.status='pending';const raw=event(r.invitation_id);const job=await receivePartnerWebhook(safe,raw,signature(raw),ports);await processPartnerInvitation(safe,x.tenant,job.invitationId,ports);
 expect(await partnerStatus(safe,x.tenant,ports,x.actor)).toMatchObject({id:next.id,errorCode:'PARTNER_OTHER_INVITATION_CHANGED'});
 expect((await owner.query("SELECT * FROM whatsapp_partner_invitations WHERE tenant_id=$1 AND phase='pending'",[x.tenant])).rows).toHaveLength(1);
});
it('worker y retomar simultáneos conservan el orden de locks y no provocan deadlock',async()=>{
 const x=await begin();await complete(x.tenant);let reached!:()=>void,release!:()=>void;
 const held=new Promise<void>(r=>reached=r),go=new Promise<void>(r=>release=r);let once=false;
 const paused=new Proxy(safe,{get(target,key){if(key!=='connect')return Reflect.get(target,key,target);return async()=>{
  const c=await safe.connect();return new Proxy(c,{get(target,key){if(key!=='query')return Reflect.get(target,key,target);return async(...args:Parameters<typeof c.query>)=>{const value=await c.query(...args);if(!once&&String(args[0]).startsWith('SELECT * FROM whatsapp_partner_invitations')&&String(args[0]).endsWith('FOR UPDATE')){once=true;reached();await go;}return value;};}});
 };}}) as Pool;
 const work=processPartnerInvitation(paused,x.tenant,x.state.id!,ports);await held;
 let resumePid=0;let connected!:()=>void;const ready=new Promise<void>(r=>connected=r);const observed=new Proxy(safe,{get(target,key){if(key!=='connect')return Reflect.get(target,key,target);return async()=>{const c=await safe.connect();resumePid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;connected();return c;};}}) as Pool;
 const resume=resumePartnerInvitation(observed,{...x.actor,id:x.state.id!},ports).catch(e=>e);
 await ready;try{let waiting=false;const deadline=performance.now()+1500;while(performance.now()<deadline&&!waiting){if(resumePid)waiting=(await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[resumePid])).rows[0]?.waiting===true;else await new Promise<void>(r=>setImmediate(r));}expect(waiting).toBe(true);}finally{release();}
 await work;const result=await resume;expect(result).not.toHaveProperty('code','40P01');if(result instanceof Error)expect(result).toMatchObject({code:'PARTNER_UNCERTAIN',status:409});else expect(result).toMatchObject({tenantId:x.tenant,invitationId:x.state.id});expect((await row(x.tenant)).phase).toBe('active');
});

it('custodia de WhatsApp se comparte con IG del mismo sender sin rotar ni mover receptor (#74)',async()=>{
 const x=await begin();await complete(x.tenant);await deliver(x.tenant);const r=await row(x.tenant);
 const rotations=calls.filter(c=>c.path.endsWith('/webhook/secret')).length;
 const primary=await withTenant(safe,x.tenant,c=>getChannelAccount(c,x.tenant,r.account_id));
 const secondary=await withTenant(safe,x.tenant,async c=>{
  const account=await createChannelAccount(c,{tenantId:x.tenant,kind:'instagram',name:'IG ficticio',credentialRef:primary.credentialRef!,config:{senderId:r.sender_id}});
  await copyChannelWebhookSecret(c,{tenantId:x.tenant,sourceAccountId:primary.id,accountId:account.id});
  await reservarEmisor(c,{tenantId:x.tenant,senderId:r.sender_id,accountId:account.id});
  return setChannelState(c,{tenantId:x.tenant,accountId:account.id,state:'active'});
 });
 expect((await withTenant(safe,x.tenant,c=>getChannelAccount(c,x.tenant,secondary.id))).webhookSecretRef).toBe(primary.webhookSecretRef);
 expect(await resolveChannelWebhookSecret(primary,ports.secrets)).toBe(`synthetic_${r.sender_id}`);
 expect((await withTenant(safe,x.tenant,c=>cuentaDelEmisor(c,{tenantId:x.tenant,webhookAccountId:primary.id,senderId:r.sender_id,kind:'instagram'})))?.id).toBe(secondary.id);
 expect(calls.filter(c=>c.path.endsWith('/webhook/secret'))).toHaveLength(rotations);
 const other=await begin();await expect(withTenant(safe,other.tenant,c=>copyChannelWebhookSecret(c,{tenantId:other.tenant,sourceAccountId:primary.id,accountId:secondary.id}))).rejects.toThrow();
});

it('snapshot antiguo de URL no pisa un reenvío más nuevo confirmado entre transacciones',async()=>{
 const x=await begin();const r=await row(x.tenant);const inv=remote.get(r.invitation_id)!;inv.url='https://dashboard.zavu.dev/invite/old_generation';
 let reached!:()=>void,release!:()=>void;const held=new Promise<void>(r=>reached=r),go=new Promise<void>(r=>release=r);let once=false;
 const paused=new Proxy(safe,{get(target,key){if(key!=='connect')return Reflect.get(target,key,target);return async()=>{
  const c=await safe.connect();let status=false;return new Proxy(c,{get(target,key){if(key!=='query')return Reflect.get(target,key,target);return async(...args:Parameters<typeof c.query>)=>{const sql=String(args[0]);const value=await c.query(...args);if(sql.startsWith('UPDATE whatsapp_partner_invitations SET provider_status'))status=true;if(sql==='COMMIT'&&status&&!once){once=true;reached();await go;}return value;};}});
 };}}) as Pool;
 const old=processPartnerInvitation(paused,x.tenant,r.id,ports);await held;
 try{inv.url='https://dashboard.zavu.dev/invite/current_generation';await processPartnerInvitation(safe,x.tenant,r.id,ports);}finally{release();}
 await old;expect((await partnerStatus(safe,x.tenant,ports,x.actor)).url).toBe(inv.url);
});
