import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {withTenant} from '@iaxti/db';
import type {ModuleRegistry,Consumer} from '@iaxti/core';
import {gmailContactEmail,type GmailThreads} from '@iaxti/google';
import {grantGoogleDelUsuario,bloquearGrantGoogle,iniciarGoogleConsent,completarGoogleConsent,conGoogleConsent,revocarGoogleConsent,limpiarGoogleConsent,roleOf,type GoogleAudit} from '@iaxti/module-identity';
import {baseRoleHasPermission,isBaseRole,customRolePermissions} from '@iaxti/module-authorization';
import {getTenant,getPlanLimits} from '@iaxti/module-organizations';
import {writeAudit} from '@iaxti/module-audit';
import {gmailDesdeEntorno,type GmailDeps} from './gmail-config';
export interface GmailActor {tenantId:string;userId:string}
export interface GmailContext {registry:ModuleRegistry;contact?:(client:PoolClient,tenantId:string,contactId:string)=>Promise<{email:string|null;ownerId:string|null}|null>}
export interface GmailResult extends GmailThreads {state:'ready'|'no_email';fetchedAt:string|null;cached:boolean;pushActive:boolean}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const audit:GoogleAudit=async(c,e)=>writeAudit(c,{...e,actorKind:e.actor==='system'?'system':'user',resource:'google_integration'});
const now=(d:GmailDeps)=>d.ahora?.()??new Date();
const required=(d:GmailDeps|null)=>{if(!d)throw new Error('Gmail todavía no está configurado. Pide a quien administra la plataforma que revise la conexión.');return d;};
export class GmailAccessError extends Error {constructor(public readonly code:'PERMISSION_DENIED'|'MODULE_DISABLED'|'MODULE_NOT_IN_PLAN'){super('No puedes consultar Gmail con el acceso actual. Revisa tus permisos y el plan del negocio.');}}
async function authorize(c:PoolClient,input:GmailActor,ctx:GmailContext,permission:string,contact=false,plan=true){
  if(!ctx.registry.isActive('integrations')||(contact&&!ctx.registry.isActive('crm')))throw new GmailAccessError('MODULE_DISABLED');
  const role=await roleOf(c,input.tenantId,input.userId);const catalog=new Set(ctx.registry.permissionsCatalog().keys());
  const custom=role&&!isBaseRole(role)?await customRolePermissions(c,input.tenantId,role):null;
  for(const p of [permission,...contact?['crm.contacts.read']:[]]){
    if(!role||!(isBaseRole(role)?baseRoleHasPermission(role,p,catalog):(catalog.has(p)&&custom?.includes(p))))throw new GmailAccessError('PERMISSION_DENIED');
  }
  const canReadAll=Boolean(role&&(isBaseRole(role)?baseRoleHasPermission(role,'crm.read_all',catalog):custom?.includes('crm.read_all')));
  if(plan){const tenant=await getTenant(c,input.tenantId);const limits=await getPlanLimits(c,tenant.plan);
    if(!['trial','active','past_due'].includes(tenant.state)||!limits.modules.includes('integrations'))throw new GmailAccessError('MODULE_NOT_IN_PLAN');}
  return{canReadAll};
}
async function contactFor(c:PoolClient,input:GmailActor&{contactId:string},ctx:GmailContext){
  const{canReadAll}=await authorize(c,input,ctx,'integrations.read',true);
  if(!ctx.contact)throw new GmailAccessError('MODULE_DISABLED');
  const contact=await ctx.contact(c,input.tenantId,input.contactId);
  if(!contact||(!canReadAll&&contact.ownerId!==input.userId))throw new GmailAccessError('PERMISSION_DENIED');
  return contact;
}
export async function estadoGmail(pool:Pool,input:GmailActor,ctx:GmailContext,deps=gmailDesdeEntorno()){
  return withTenant(pool,input.tenantId,async c=>{
    await authorize(c,input,ctx,'integrations.read',false,false);
    const grant=await grantGoogleDelUsuario(c,input.tenantId,input.userId);
    const row=(await c.query('SELECT watch_expires_at,last_notification_at,grant_generation FROM gmail_connections WHERE tenant_id=$1 AND user_id=$2',[input.tenantId,input.userId])).rows[0];
    return{configured:Boolean(deps),status:grant?.services.includes('gmail')?grant.status:'disconnected',pushActive:Boolean(grant?.status==='active'&&grant.services.includes('gmail')&&Number(row?.grant_generation)===grant.generation&&row?.watch_expires_at&&new Date(row.watch_expires_at).getTime()>(deps?now(deps).getTime():Date.now())),lastNotificationAt:row?.last_notification_at??null};
  });
}
export async function iniciarGmail(pool:Pool,input:GmailActor&{challenge:string},ctx:GmailContext,injected=gmailDesdeEntorno()){
  const deps=required(injected);await withTenant(pool,input.tenantId,c=>authorize(c,input,ctx,'integrations.connect'));
  return iniciarGoogleConsent(pool,{...input,service:'gmail'},deps,audit);
}
export async function completarGmail(pool:Pool,input:GmailActor&{state:string;nonce:string;verifier:string;code:string},ctx:GmailContext,injected=gmailDesdeEntorno()){
  const deps=required(injected);await withTenant(pool,input.tenantId,c=>authorize(c,input,ctx,'integrations.connect'));
  await completarGoogleConsent(pool,{...input,service:'gmail'},deps,audit,async(c,grant)=>{
    await authorize(c,input,ctx,'integrations.connect');
    await c.query(`INSERT INTO gmail_connections(id,tenant_id,user_id,grant_generation) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET grant_generation=EXCLUDED.grant_generation,mailbox_hash=NULL,watch_expires_at=NULL,last_history=0`,[randomUUID(),input.tenantId,input.userId,grant.generation]);
    await c.query('DELETE FROM gmail_thread_cache WHERE tenant_id=$1 AND connection_id IN(SELECT id FROM gmail_connections WHERE tenant_id=$1 AND user_id=$2)',[input.tenantId,input.userId]);
  });
  await renovarGmail(pool,input,ctx,deps).catch(()=>{});
  return estadoGmail(pool,input,ctx,deps);
}
export async function revocarGmail(pool:Pool,input:GmailActor,ctx:GmailContext,injected=gmailDesdeEntorno()){
  await withTenant(pool,input.tenantId,c=>authorize(c,input,ctx,'integrations.connect',false,false));
  return revocarGoogleConsent(pool,input,required(injected),audit,async(c,target)=>{
    await c.query('DELETE FROM gmail_connections WHERE tenant_id=$1 AND user_id=$2',[target.tenantId,target.userId]);
  });
}
export async function hilosGmail(pool:Pool,input:GmailActor&{contactId:string;refresh?:boolean},ctx:GmailContext,injected=gmailDesdeEntorno()):Promise<GmailResult>{
  const deps=required(injected);
  // Permisos antes de secretos/caché; se vuelven a comprobar dentro del lock.
  await withTenant(pool,input.tenantId,c=>contactFor(c,input,ctx));
  return conGoogleConsent(pool,{...input,service:'gmail',action:'google.gmail.threads'},deps,audit,async(c,token,grant)=>{
    const{email}=await contactFor(c,input,ctx);
    if(!email)return{state:'no_email',threads:[],truncated:false,fetchedAt:null,cached:false,pushActive:false};
    const normalized=gmailContactEmail(email.trim());
    const row=(await c.query('SELECT * FROM gmail_connections WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[input.tenantId,input.userId])).rows[0];
    if(!row)throw new Error('Vuelve a conectar Gmail para consultar tu correo.');
    const pushActive=Boolean(Number(row.grant_generation)===grant.generation&&row.watch_expires_at&&new Date(row.watch_expires_at).getTime()>now(deps).getTime());
    if(!input.refresh&&pushActive){
      const cached=(await c.query(`SELECT summaries,fetched_at FROM gmail_thread_cache WHERE tenant_id=$1 AND connection_id=$2 AND contact_id=$3
        AND email_hash=$4 AND grant_generation=$5 AND history_id=$6 AND expires_at>$7`,[input.tenantId,row.id,input.contactId,hash(normalized),grant.generation,row.last_history,now(deps)])).rows[0];
      if(cached)return{...cached.summaries,state:'ready',fetchedAt:new Date(cached.fetched_at).toISOString(),cached:true,pushActive};
    }
    const result=await deps.gmail.threads({accessToken:token,email:normalized});
    // El contacto pudo cambiar mientras Google respondía; no mostrar correo ajeno.
    if((await contactFor(c,input,ctx)).email?.trim().toLowerCase()!==normalized)throw new Error('El correo del contacto cambió. Vuelve a consultar la ficha.');
    const fetchedAt=now(deps);
    await c.query(`INSERT INTO gmail_thread_cache(tenant_id,connection_id,contact_id,email_hash,grant_generation,history_id,summaries,fetched_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,connection_id,contact_id) DO UPDATE SET
      email_hash=EXCLUDED.email_hash,grant_generation=EXCLUDED.grant_generation,history_id=EXCLUDED.history_id,summaries=EXCLUDED.summaries,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at`,
      [input.tenantId,row.id,input.contactId,hash(normalized),grant.generation,row.last_history,JSON.stringify(result),fetchedAt,new Date(fetchedAt.getTime()+60000)]);
    return{...result,state:'ready',fetchedAt:fetchedAt.toISOString(),cached:false,pushActive};
  });
}
/** Solo profile y watch. Nunca lista correo desde el scheduler. */
export async function renovarGmail(pool:Pool,input:GmailActor,ctx:GmailContext,injected=gmailDesdeEntorno()){
  const deps=required(injected);await withTenant(pool,input.tenantId,async c=>{
    await authorize(c,input,ctx,'integrations.connect');
    await c.query('UPDATE gmail_connections SET last_watch_attempt_at=$3 WHERE tenant_id=$1 AND user_id=$2',[input.tenantId,input.userId,now(deps)]);
  });
  return conGoogleConsent(pool,{...input,service:'gmail',action:'google.gmail.watch'},deps,audit,async(c,token,grant)=>{
    await authorize(c,input,ctx,'integrations.connect');
    const row=(await c.query('SELECT * FROM gmail_connections WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[input.tenantId,input.userId])).rows[0];
    if(!row)return false;
    if(Number(row.grant_generation)===grant.generation&&row.watch_expires_at&&new Date(row.watch_expires_at).getTime()>now(deps).getTime()+86400000)return false;
    const profile=await deps.gmail.profile(token);
    const watched=await deps.gmail.watch({accessToken:token,topicName:deps.topicName});
    if(watched.expiration<=now(deps).getTime())throw new Error('Gmail no confirmó las notificaciones. Reintenta la conexión.');
    await c.query('UPDATE gmail_connections SET mailbox_hash=$3,watch_expires_at=$4,grant_generation=$5 WHERE tenant_id=$1 AND user_id=$2',[input.tenantId,input.userId,hash(profile.emailAddress),new Date(watched.expiration),grant.generation]);
    // No se avanza last_history con watch: una renovación no sincroniza datos.
    await c.query('DELETE FROM gmail_thread_cache WHERE tenant_id=$1 AND connection_id=$2',[input.tenantId,row.id]);
    return true;
  });
}
export async function mantenerGmail(pool:Pool,ctx:GmailContext,deps=gmailDesdeEntorno()){
  const result={renewed:0,failed:0};if(!deps||!ctx.registry.isActive('integrations'))return result;
  const candidates=await pool.query<{tenant_id:string}>('SELECT tenant_id FROM tenants_con_mantenimiento_gmail($1)',[now(deps)]);
  for(const{tenant_id:tenantId}of candidates.rows){
    const users=await withTenant(pool,tenantId,async c=>{
      await c.query('DELETE FROM gmail_thread_cache WHERE tenant_id=$1 AND expires_at<=$2',[tenantId,now(deps)]);
      return(await c.query(`WITH candidates AS (SELECT id FROM gmail_connections WHERE tenant_id=$1 AND (watch_expires_at IS NULL OR watch_expires_at<$2)
        ORDER BY last_watch_attempt_at NULLS FIRST,id LIMIT 100 FOR UPDATE SKIP LOCKED)
        UPDATE gmail_connections g SET last_watch_attempt_at=$3 FROM candidates c WHERE g.id=c.id AND g.tenant_id=$1 RETURNING g.user_id`,
        [tenantId,new Date(now(deps).getTime()+86400000),now(deps)])).rows;
    });
    for(const row of users){try{if(await renovarGmail(pool,{tenantId,userId:row.user_id},ctx,deps))result.renewed++;}catch{result.failed++;}}
  }
  return result;
}
export interface GmailPush {mailboxHash:string;historyId:string;messageId:string}
export async function autenticarPushGmail(token:string,body:unknown,injected=gmailDesdeEntorno()):Promise<GmailPush>{
  const deps=required(injected);await deps.pubsub.verify(token);
  try{
    if(!body||typeof body!=='object')throw new Error();const envelope=body as {subscription?:unknown;message?:{data?:unknown;messageId?:unknown}};
    if(envelope.subscription!==deps.subscription||typeof envelope.message?.messageId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(envelope.message.messageId)
      ||typeof envelope.message.data!=='string'||envelope.message.data.length>8192||! /^[A-Za-z0-9+/]+={0,2}$/.test(envelope.message.data))throw new Error();
    const data=JSON.parse(Buffer.from(envelope.message.data,'base64').toString('utf8')) as {emailAddress?:unknown;historyId?:unknown};
    if(typeof data.emailAddress!=='string'||typeof data.historyId!=='string'||! /^[1-9][0-9]{0,39}$/.test(data.historyId))throw new Error();
    return{mailboxHash:hash(gmailContactEmail(data.emailAddress)),historyId:data.historyId,messageId:envelope.message.messageId};
  }catch{throw new Error('La notificación de Gmail no es válida.');}
}
/** El cuerpo encolado ya no contiene el buzón. Un fallo conserva el job para retry. */
export async function procesarPushGmail(pool:Pool,input:GmailPush){
  if(!/^[0-9a-f]{64}$/.test(input.mailboxHash)||! /^[1-9][0-9]{0,39}$/.test(input.historyId))throw new Error('Notificación inválida.');
  const tenants=await pool.query<{tenant_id:string}>('SELECT tenant_id FROM tenants_del_buzon_gmail($1)',[input.mailboxHash]);let changed=0;
  for(const{tenant_id:tenantId}of tenants.rows)await withTenant(pool,tenantId,async c=>{
    const rows=await c.query(`UPDATE gmail_connections SET last_history=$3,last_notification_at=now()
      WHERE tenant_id=$1 AND mailbox_hash=$2 AND last_history<$3 RETURNING id`,[tenantId,input.mailboxHash,input.historyId]);
    for(const row of rows.rows){await c.query('DELETE FROM gmail_thread_cache WHERE tenant_id=$1 AND connection_id=$2',[tenantId,row.id]);
      await audit(c,{tenantId,actor:'system',action:'google.gmail.push',resourceId:row.id,result:'ok'});changed++;}
  });
  return{changed};
}
export function gmailConsumers():Consumer[]{return[{name:'integrations.gmail_contact_anonymized',moduleId:'integrations',event:'contact.anonymized',handler:async(event,c)=>{
  if(typeof event.payload.contactId!=='string')return;
  await c.query('DELETE FROM gmail_thread_cache WHERE tenant_id=$1 AND contact_id=$2',[event.tenantId,event.payload.contactId]);
}},{name:'integrations.gmail_connected',moduleId:'integrations',event:'integration.connected',handler:async(event,c)=>{
  const{provider,userId,grantId}=event.payload;if(provider!=='google'||typeof userId!=='string'||typeof grantId!=='string')return;
  const grant=await bloquearGrantGoogle(c,{tenantId:event.tenantId,userId,noEsperar:true});if(!grant||grant.id!==grantId||grant.status!=='active')return;
  if(!grant.services.includes('gmail')){await c.query('DELETE FROM gmail_connections WHERE tenant_id=$1 AND user_id=$2',[event.tenantId,userId]);return;}
  const rows=await c.query('UPDATE gmail_connections SET watch_expires_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND grant_generation<>$3 RETURNING id',[event.tenantId,userId,grant.generation]);
  for(const row of rows.rows)await c.query('DELETE FROM gmail_thread_cache WHERE tenant_id=$1 AND connection_id=$2',[event.tenantId,row.id]);
}},{name:'integrations.gmail_revoked',moduleId:'integrations',event:'integration.revoked',handler:async(event,c)=>{
  const{provider,userId,grantId}=event.payload;if(provider!=='google'||typeof userId!=='string'||typeof grantId!=='string')return;
  const grant=await bloquearGrantGoogle(c,{tenantId:event.tenantId,userId,noEsperar:true});if(!grant||grant.id!==grantId||grant.status!=='revoked')return;
  await c.query('DELETE FROM gmail_connections WHERE tenant_id=$1 AND user_id=$2',[event.tenantId,userId]);
}}];}

/** Conservación física de extractos: también con módulo apagado o tenant suspendido. */
export async function limpiarCacheGmail(pool:Pool,instant=new Date()):Promise<number>{
  const tenants=await pool.query<{tenant_id:string}>('SELECT tenant_id FROM tenants_con_cache_gmail_vencida($1)',[instant]);
  let deleted=0;
  for(const{tenant_id:tenantId}of tenants.rows)deleted+=await withTenant(pool,tenantId,async c=>(await c.query('DELETE FROM gmail_thread_cache WHERE tenant_id=$1 AND expires_at<=$2',[tenantId,instant])).rowCount??0);
  return deleted;
}
export async function limpiarSecretosGmail(pool:Pool,deps=gmailDesdeEntorno()){
  return limpiarGoogleConsent(pool,deps,audit);
}
