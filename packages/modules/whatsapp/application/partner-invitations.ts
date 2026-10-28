import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';
import { getTenant } from '@iaxti/module-organizations';
import { getChannelAccount, setChannelState, setChannelWebhookSecret, webhookSecretResourcePrefix } from '@iaxti/module-channels';
import { connectWhatsAppNumber } from './numbers';
import { EVENTOS_WEBHOOK, llaveSirveParaAmbiente, urlWebhook } from './conectar';
import { verifyZavuSignature } from './zavu';
import { invitationFrom, PartnerError, type PartnerPorts, type PartnerInvitation } from './partner-provider';

type Row={id:string;tenant_id:string;project_id:string;credential_ref:string;phase:string;invitation_id:string|null;provider_status:string|null;account_id:string|null;sender_id:string|null;url_ref:string|null;url_generation:string;provision_id:string|null;expires_at:Date|null;error_code:string|null;updated_at:Date;actor:string;actor_kind:ActorKind};
export interface PartnerActor {tenantId:string;actor:string;actorKind:ActorKind;requestId?:string}
export interface PartnerStatus {id:string|null;phase:string;providerStatus:string|null;url:string|null;expiresAt:string|null;accountId:string|null;errorCode:string|null}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function isLinkRef(ref:string,id:string) {
  const prefix=`iaxti-zavu-invite-${id.replaceAll('-','')}-`;
  const match=/^projects\/[^/]+\/secrets\/([A-Za-z0-9_-]+)\/versions\/[1-9][0-9]{0,19}$/.exec(ref);
  return !!match&&match[1]!.startsWith(prefix)&&/^[a-f0-9]{32}$/.test(match[1]!.slice(prefix.length));
}
async function audit(c:PoolClient,row:Pick<Row,'tenant_id'|'id'>,action:string,result:'ok'|'error'='ok',actor?:PartnerActor) {
  await writeAudit(c,{tenantId:row.tenant_id,actor:actor?.actor??'system',actorKind:actor?.actorKind??'system',requestId:actor?.requestId,action,resource:'whatsapp_invitation',resourceId:row.id,result});
}
async function usable(c:PoolClient,t:string,ports:PartnerPorts) {
  if(!ports.enabled())throw new PartnerError('MODULE_DISABLED','La conexión de WhatsApp está desactivada.',403);
  const tenant=await getTenant(c,t,true);
  if(!['active','trial','past_due'].includes(tenant.state))throw new PartnerError('TENANT_READ_ONLY','Tu negocio no puede conectar un número en este estado.',403);
  return tenant;
}
async function rowById(c:PoolClient,t:string,id:string,lock=false) {
  const r=await c.query<Row>(`SELECT * FROM whatsapp_partner_invitations WHERE tenant_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[t,id]);
  if(!r.rows[0])throw new PartnerError('PARTNER_NOT_FOUND','No encontramos esa conexión.',404);
  return r.rows[0];
}
function dto(r:Row|null,url:string|null=null):PartnerStatus {
  const phase=r?.phase==='pending'&&r.provider_status==='pending'&&r.expires_at&&r.expires_at.getTime()<=Date.now()?'checking_expiry':r?.phase??'none';
  return {id:r?.id??null,phase,providerStatus:r?.provider_status??null,url,expiresAt:r?.expires_at?.toISOString()??null,accountId:r?.account_id??null,errorCode:r?.error_code??null};
}
export async function partnerStatus(pool:Pool,t:string,ports:PartnerPorts,actor?:PartnerActor):Promise<PartnerStatus> {
  let failed=false;
  const result=await withTenant(pool,t,async c=>{
    const row=(await c.query<Row>('SELECT * FROM whatsapp_partner_invitations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[t])).rows[0]??null;
    if(!row)return dto(null);
    await expire(c,row);
    if(row.phase==='active' && row.account_id && (await getChannelAccount(c,t,row.account_id)).state==='disconnected')return {...dto(row),phase:'disconnected'};
    let url:string|null=null;
    if(row.url_ref && row.phase==='pending') {
      const valid=await c.query('SELECT 1 FROM whatsapp_partner_secrets WHERE tenant_id=$1 AND invitation_id=$2 AND version_ref=$3 AND purpose=\'url\' AND NOT destroy_pending',[t,row.id,row.url_ref]);
      try {
        if(!valid.rowCount || !isLinkRef(row.url_ref,row.id))throw new Error('reference');
        url=await ports.secrets.access(row.url_ref);
      }catch{failed=true;}
      await audit(c,row,'whatsapp.invitation.link_accessed',failed?'error':'ok',actor);
    }
    return dto(row,url);
  });
  if(failed)throw new PartnerError('PARTNER_LINK_UNAVAILABLE','No pudimos recuperar el enlace seguro. Revisa la conexión e intenta de nuevo.',503);
  return result;
}
async function expire(c:PoolClient,r:Row) {
  if(r.phase==='pending' && r.provider_status==='pending' && r.url_ref && r.expires_at && r.expires_at.getTime()<=Date.now()) {
    // Retirar el enlace vencido no prueba que el proveedor no completara antes.
    await retireUrl(c,r);r.url_ref=null;
    await audit(c,r,'whatsapp.invitation.link_expired');
  }
}

async function project(ports:PartnerPorts) {
  const me=await ports.call('/me'); const p=me.project as {id?:string;name?:string}|undefined;
  if(p?.id!==ports.config.projectId || typeof me.isTestMode!=='boolean')throw new PartnerError('PARTNER_PROJECT_MISMATCH','No pudimos comprobar el proyecto de WhatsApp.',503);
  const allowed=llaveSirveParaAmbiente({project:{id:p.id,name:p.name??''},isTestMode:me.isTestMode},process.env.IAXTI_ENV,process.env.ZAVU_ENVIOS_REALES==='1');
  if(!allowed.ok)throw new PartnerError('PARTNER_ENVIRONMENT_MISMATCH','La conexión de WhatsApp no corresponde a este ambiente.',503);
}
async function prepareSecret(pool:Pool,t:string,id:string,purpose:'url'|'webhook',secretId:string) {
  await withTenant(pool,t,async c=>{
    await rowById(c,t,id,true);
    await c.query('INSERT INTO whatsapp_partner_secrets(tenant_id,invitation_id,secret_id,purpose) VALUES($1,$2,$3,$4)',[t,id,secretId,purpose]);
    await audit(c,{tenant_id:t,id},'whatsapp.secret.intent');
  });
}
async function saveUrl(pool:Pool,t:string,id:string,url:string,generation:string,ports:PartnerPorts) {
  const secretId=`iaxti-zavu-invite-${id.replaceAll('-','')}-${randomUUID().replaceAll('-','')}`;
  await prepareSecret(pool,t,id,'url',secretId);
  await withTenant(pool,t,async c=>{
    const r=await rowById(c,t,id,true);
    if(r.url_generation!==generation || (r.provider_status==='pending' && r.expires_at && r.expires_at.getTime()<=Date.now()))return;
    const intent=await c.query('SELECT 1 FROM whatsapp_partner_secrets WHERE tenant_id=$1 AND secret_id=$2 AND destroy_pending FOR UPDATE',[t,secretId]);
    if(!intent.rowCount)throw new PartnerError('PARTNER_LINK_UNAVAILABLE','La preparación del enlace venció. Revisa la conexión para recuperarlo.',503);
    if(!['pending','failed'].includes(r.phase))return;
    if(r.url_ref) {
      const previous=await c.query("SELECT 1 FROM whatsapp_partner_secrets WHERE tenant_id=$1 AND invitation_id=$2 AND version_ref=$3 AND purpose='url' AND NOT destroy_pending FOR UPDATE",[t,id,r.url_ref]);
      if(!previous.rowCount || !isLinkRef(r.url_ref,id))throw new PartnerError('PARTNER_LINK_UNAVAILABLE','No pudimos comprobar el enlace anterior.',503);
      if(await ports.secrets.access(r.url_ref)===url)return;
      await c.query('UPDATE whatsapp_partner_secrets SET destroy_pending=true WHERE tenant_id=$1 AND invitation_id=$2 AND version_ref=$3',[t,id,r.url_ref]);
    }
    const ref=await ports.secrets.put(secretId,url);
    await c.query('UPDATE whatsapp_partner_invitations SET url_ref=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',[t,id,ref]);
    await c.query('UPDATE whatsapp_partner_secrets SET version_ref=$3,destroy_pending=false WHERE tenant_id=$1 AND secret_id=$2',[t,secretId,ref]);
    await audit(c,r,'whatsapp.invitation.link_ready');
  });
}
export async function startPartnerInvitation(pool:Pool,input:PartnerActor&{key:string},ports:PartnerPorts):Promise<PartnerStatus> {
  await project(ports);
  const prepared=await withTenant(pool,input.tenantId,async c=>{
    const tenant=await usable(c,input.tenantId,ports);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`partner:${input.tenantId}`]);
    const existing=await c.query<Row>(`SELECT * FROM whatsapp_partner_invitations WHERE tenant_id=$1 AND (request_hash=$2 OR phase NOT IN ('expired','cancelled','failed','active')) ORDER BY created_at DESC LIMIT 1`,[input.tenantId,hash(input.key)]);
    if(existing.rows[0])return {row:existing.rows[0],create:false,name:tenant.name};
    const id=randomUUID();
    const r=await c.query<Row>(`INSERT INTO whatsapp_partner_invitations(id,tenant_id,project_id,credential_ref,request_hash,actor,actor_kind,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'creating') RETURNING *`,[id,input.tenantId,ports.config.projectId,ports.config.credentialRef,hash(input.key),input.actor,input.actorKind]);
    await audit(c,r.rows[0]!,'whatsapp.invitation.requested','ok',input);
    return {row:r.rows[0]!,create:true,name:tenant.name};
  });
  if(!prepared.create)return partnerStatus(pool,input.tenantId,ports,input);
  let remote: PartnerInvitation;const generation=randomUUID();
  try {
    remote=invitationFrom(await ports.call('/invitations','POST',{clientName:prepared.name.slice(0,100),connectionType:'whatsapp_waba'}));
    await withTenant(pool,input.tenantId,async c=>{
      const r=await rowById(c,input.tenantId,prepared.row.id,true);
      await c.query("UPDATE whatsapp_partner_invitations SET invitation_id=$3,provider_status=$4,expires_at=$5,url_generation=$6,phase='pending',updated_at=now() WHERE tenant_id=$1 AND id=$2",[input.tenantId,r.id,remote.id,remote.status,remote.expiresAt,generation]);
      await audit(c,r,'whatsapp.invitation.created','ok',input);
    });
  }catch {
    await withTenant(pool,input.tenantId,async c=>{
      const r=await rowById(c,input.tenantId,prepared.row.id,true);
      if(r.phase==='creating') {await c.query("UPDATE whatsapp_partner_invitations SET phase='ambiguous',error_code='PARTNER_CREATE_UNCERTAIN',updated_at=now() WHERE tenant_id=$1 AND id=$2",[input.tenantId,r.id]);await audit(c,r,'whatsapp.invitation.uncertain','error',input);}
    });
    return partnerStatus(pool,input.tenantId,ports,input);
  }
  await saveUrl(pool,input.tenantId,prepared.row.id,remote.url,generation,ports);
  return partnerStatus(pool,input.tenantId,ports,input);
}

export async function receivePartnerWebhook(pool:Pool,raw:string,signature:string|undefined,ports:PartnerPorts):Promise<{tenantId:string;invitationId:string;eventId:string}> {
  if(!ports.enabled())throw new PartnerError('MODULE_DISABLED','La conexión está desactivada.',503);
  if(!verifyZavuSignature(signature,raw,ports.config.projectWebhookSecret))throw new PartnerError('INVALID_SIGNATURE','No pudimos comprobar la firma.',401);
  let event:Record<string,unknown>;try{event=JSON.parse(raw);}catch{throw new PartnerError('INVALID_WEBHOOK','No pudimos leer el evento.',400);}
  if(!event || typeof event!=='object' || Array.isArray(event))throw new PartnerError('INVALID_WEBHOOK','No pudimos leer el evento.',400);
  const data=event.data as Record<string,unknown>|undefined;
  if(event.projectId!==ports.config.projectId || event.type!=='invitation.status_changed' || typeof event.id!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(event.id) || typeof data?.invitationId!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.invitationId)) throw new PartnerError('INVALID_WEBHOOK','El evento no corresponde a este proyecto.',400);
  const found=await pool.query<{tenant:string|null}>('SELECT whatsapp_partner_tenant($1,$2) AS tenant',[ports.config.projectId,data.invitationId]);
  const t=found.rows[0]?.tenant;
  // No reconocer un evento antes del COMMIT: Zavu debe volver a entregarlo.
  if(!t)throw new PartnerError('PARTNER_NOT_FOUND','La invitación aún no está registrada. Reintenta la entrega.',503);
  const eventId=event.id;
  return withTenant(pool,t,async c=>{
    await c.query("SET LOCAL statement_timeout='600ms'");
    await c.query("SET LOCAL lock_timeout='500ms'");
    const r=(await c.query<Row>('SELECT * FROM whatsapp_partner_invitations WHERE tenant_id=$1 AND project_id=$2 AND invitation_id=$3',[t,ports.config.projectId,data.invitationId])).rows[0]!;
    const inserted=await c.query('INSERT INTO whatsapp_partner_events(tenant_id,invitation_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[t,r.id,event.id]);
    if(inserted.rowCount)await audit(c,r,'whatsapp.invitation.event_received');
    return {tenantId:t,invitationId:r.id,eventId};
  });
}
export async function resumePartnerInvitation(pool:Pool,input:PartnerActor&{id:string},ports:PartnerPorts) {
  return withTenant(pool,input.tenantId,async c=>{
    await usable(c,input.tenantId,ports);
    const r=await rowById(c,input.tenantId,input.id,true);
    if(r.phase==='ambiguous'||r.phase==='creating'||r.phase==='provisioning')throw new PartnerError('PARTNER_UNCERTAIN','No podemos repetir un paso sin confirmar su resultado. Revisa el estado más tarde.');
    if(r.phase==='active'||r.phase==='cancelled'||r.phase==='expired')return {tenantId:input.tenantId,invitationId:r.id,eventId:`resume-${randomUUID()}`};
    if(r.account_id && (await getChannelAccount(c,input.tenantId,r.account_id)).state!=='connecting')throw new PartnerError('PARTNER_ACCOUNT_CHANGED','La cuenta cambió. Revisa el canal antes de continuar.');
    if(r.phase==='recovery_required')await c.query("UPDATE whatsapp_partner_invitations SET phase='connecting',error_code=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[input.tenantId,r.id]);
    const eventId=`resume-${randomUUID()}`;
    await c.query('INSERT INTO whatsapp_partner_events(tenant_id,invitation_id,event_id) VALUES($1,$2,$3)',[input.tenantId,r.id,eventId]);
    await audit(c,r,'whatsapp.invitation.resumed','ok',input);
    return {tenantId:input.tenantId,invitationId:r.id,eventId};
  });
}

export async function processPartnerInvitation(pool:Pool,t:string,id:string,ports:PartnerPorts):Promise<void> {
  const prepared=await withTenant(pool,t,async c=>{
    await usable(c,t,ports);
    const r=await rowById(c,t,id,true);
    await expire(c,r);
    if(['active','ambiguous','recovery_required'].includes(r.phase)) {
      await c.query('UPDATE whatsapp_partner_events SET processed_at=now() WHERE tenant_id=$1 AND invitation_id=$2 AND processed_at IS NULL',[t,id]);return null;
    }
    if(r.project_id!==ports.config.projectId || r.credential_ref!==ports.config.credentialRef)throw new PartnerError('PARTNER_PROJECT_MISMATCH','La configuración de la conexión cambió.');
    if(['creating','provisioning'].includes(r.phase)) {
      if(Date.now()-r.updated_at.getTime()>120000) {
        await c.query("UPDATE whatsapp_partner_invitations SET phase=$3,error_code=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",[t,id,r.phase==='creating'?'ambiguous':'recovery_required',r.phase==='creating'?'PARTNER_CREATE_UNCERTAIN':'PARTNER_SECRET_UNCERTAIN']);
        await audit(c,r,'whatsapp.invitation.interrupted','error');
      }
      return null;
    }
    if(!r.invitation_id)return null;
    await project(ports);
    const remote=invitationFrom(await ports.call(`/invitations/${encodeURIComponent(r.invitation_id)}`),r.invitation_id);
    if(['cancelled','expired'].includes(r.phase) && !['cancelled','expired'].includes(remote.status)) {
      const newer=await c.query<Row>('SELECT * FROM whatsapp_partner_invitations WHERE tenant_id=$1 AND id<>$2 AND created_at>(SELECT created_at FROM whatsapp_partner_invitations WHERE tenant_id=$1 AND id=$2) ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[t,id]);
      if(newer.rows[0]) {
        // Una invitación vieja reenviada no sustituye silenciosamente el intento actual.
        await c.query("UPDATE whatsapp_partner_invitations SET error_code='PARTNER_OTHER_INVITATION_CHANGED' WHERE tenant_id=$1 AND id=$2",[t,newer.rows[0].id]);
        await c.query('UPDATE whatsapp_partner_events SET processed_at=now() WHERE tenant_id=$1 AND invitation_id=$2',[t,id]);
        await audit(c,r,'whatsapp.invitation.superseded','error');return null;
      }
    }
    if(remote.status!=='completed') {
      // failed es reintentable con el MISMO enlace; no habilita otra invitación.
      const generation=randomUUID();
      const phase=['expired','cancelled'].includes(remote.status)?remote.status:remote.status==='pending'&&Date.parse(remote.expiresAt)<=Date.now()?'expired':'pending';
      await c.query('UPDATE whatsapp_partner_invitations SET provider_status=$3,phase=$4,expires_at=$5,url_generation=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2',[t,id,remote.status,phase,remote.expiresAt,generation]);
      if(['expired','cancelled'].includes(phase))await retireUrl(c,r);
      await c.query('UPDATE whatsapp_partner_events SET processed_at=now() WHERE tenant_id=$1 AND invitation_id=$2',[t,id]);
      await audit(c,r,'whatsapp.invitation.status');
      return {url:phase==='pending'?remote.url:null,generation,secretId:null,accountId:null,senderId:null};
    }
    const sender=await ports.call(`/senders/${encodeURIComponent(remote.senderId!)}`);
    if(sender.id!==remote.senderId || !Array.isArray(sender.channels) || !sender.channels.includes('whatsapp') || typeof sender.name!=='string' || (sender.whatsapp as {phoneNumberId?:unknown}|undefined)?.phoneNumberId!==remote.phoneNumberId)throw new PartnerError('PARTNER_SENDER_INVALID','El emisor todavía no tiene WhatsApp habilitado.');
    let accountId=r.account_id;
    if(accountId) {
      const a=await getChannelAccount(c,t,accountId);
      if(a.state!=='connecting' || a.config.senderId!==remote.senderId || r.sender_id!==remote.senderId)throw new PartnerError('PARTNER_ACCOUNT_CHANGED','La cuenta cambió. Revisa el canal antes de continuar.');
    } else {
      const result=await connectWhatsAppNumber(c,{tenantId:t,name:sender.name.slice(0,100),senderId:remote.senderId!,phoneNumberId:remote.phoneNumberId??undefined,
        displayPhone:typeof sender.phoneNumber==='string'?sender.phoneNumber:undefined,credentialRef:r.credential_ref,webhookSecretRef:'ZAVU_PARTNER_PENDING',activar:false,enviosReales:process.env.ZAVU_ENVIOS_REALES==='1'});
      accountId=result.account.id;
    }
    const secretId=webhookSecretResourcePrefix(t,accountId)+randomUUID().replaceAll('-','');
    await c.query("INSERT INTO whatsapp_partner_secrets(tenant_id,invitation_id,secret_id,purpose) VALUES($1,$2,$3,'webhook')",[t,id,secretId]);
    await c.query("UPDATE whatsapp_partner_invitations SET phase='provisioning',provider_status='completed',sender_id=$3,account_id=$4,provision_id=$5,error_code=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[t,id,remote.senderId,accountId,secretId]);
    await retireUrl(c,r);
    await audit(c,r,'whatsapp.invitation.connecting');
    return {url:null,secretId,accountId,senderId:remote.senderId!,phoneNumberId:remote.phoneNumberId};
  });
  if(!prepared)return;
  if(!prepared.secretId) {if(prepared.url)await saveUrl(pool,t,id,prepared.url,prepared.generation!,ports);return;}
  try {
    await withTenant(pool,t,async c=>{
      await usable(c,t,ports);
      const r=await rowById(c,t,id,true);
      if(r.phase!=='provisioning' || r.provision_id!==prepared.secretId)throw new PartnerError('PARTNER_ACCOUNT_CHANGED','La conexión cambió.');
      const account=await getChannelAccount(c,t,prepared.accountId!,true);
      if(account.state!=='connecting' || account.config.senderId!==prepared.senderId)throw new PartnerError('PARTNER_ACCOUNT_CHANGED','La cuenta cambió.');
      const secretRow=await c.query('SELECT 1 FROM whatsapp_partner_secrets WHERE tenant_id=$1 AND secret_id=$2 AND destroy_pending FOR UPDATE',[t,prepared.secretId]);
      if(!secretRow.rowCount)throw new PartnerError('PARTNER_SECRET_UNCERTAIN','La custodia está pendiente.');
      const path=`/senders/${encodeURIComponent(prepared.senderId!)}`;const webhookUrl=urlWebhook(ports.config.publicApiUrl,account.id);
      await ports.call(path,'PATCH',{webhookUrl,webhookEvents:[...EVENTOS_WEBHOOK],webhookActive:false});
      const rotated=await ports.call(`${path}/webhook/secret`,'POST');
      if(typeof rotated.secret!=='string' || !rotated.secret || rotated.secret.length>4096)throw new PartnerError('PARTNER_SECRET_UNCERTAIN','No se pudo custodiar el secreto.');
      const ref=await ports.secrets.put(prepared.secretId!,rotated.secret);
      // Acceso real antes de activar: comprueba el valor custodiado, sin imprimirlo.
      if(await ports.secrets.access(ref)!==rotated.secret)throw new PartnerError('PARTNER_SECRET_UNCERTAIN','No se pudo comprobar el secreto custodiado.');
      await setChannelWebhookSecret(c,{tenantId:t,accountId:account.id,ref:`sm:${ref}`});
      await ports.call(path,'PATCH',{webhookUrl,webhookEvents:[...EVENTOS_WEBHOOK],webhookActive:true});
      const confirmed=await ports.call(path);const webhook=confirmed.webhook as {url?:unknown;active?:unknown;events?:unknown}|undefined;
      if(confirmed.id!==prepared.senderId || (confirmed.whatsapp as {phoneNumberId?:unknown}|undefined)?.phoneNumberId!==prepared.phoneNumberId || !Array.isArray(confirmed.channels) || !confirmed.channels.includes('whatsapp') || webhook?.url!==webhookUrl || webhook.active!==true || !Array.isArray(webhook.events) || !EVENTOS_WEBHOOK.every(e=>(webhook.events as unknown[]).includes(e)))throw new PartnerError('PARTNER_WEBHOOK_UNCONFIRMED','Zavu no confirmó el webhook de la conexión.');
      await usable(c,t,ports);
      await setChannelState(c,{tenantId:t,accountId:account.id,state:'active'});
      await c.query("UPDATE whatsapp_partner_invitations SET phase='active',error_code=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[t,id]);
      await c.query('UPDATE whatsapp_partner_secrets SET version_ref=$3,destroy_pending=false WHERE tenant_id=$1 AND secret_id=$2',[t,prepared.secretId,ref]);
      await c.query('UPDATE whatsapp_partner_events SET processed_at=now() WHERE tenant_id=$1 AND invitation_id=$2',[t,id]);
      await audit(c,r,'whatsapp.invitation.connected');
    });
  } catch {
    await withTenant(pool,t,async c=>{
      const r=await rowById(c,t,id,true);
      if(r.phase==='provisioning' && r.provision_id===prepared.secretId) {
        await c.query("UPDATE whatsapp_partner_invitations SET phase='recovery_required',error_code='PARTNER_PROVISION_UNCERTAIN',updated_at=now() WHERE tenant_id=$1 AND id=$2",[t,id]);
        await audit(c,r,'whatsapp.invitation.recovery_required','error');
      }
    });
  }
}
async function retireUrl(c:PoolClient,r:Row) {
  await c.query('UPDATE whatsapp_partner_invitations SET url_ref=NULL WHERE tenant_id=$1 AND id=$2',[r.tenant_id,r.id]);
  await c.query("UPDATE whatsapp_partner_secrets SET destroy_pending=true WHERE tenant_id=$1 AND invitation_id=$2 AND purpose='url'",[r.tenant_id,r.id]);
}
export async function maintainPartnerInvitations(pool:Pool,ports:PartnerPorts) {
  const tenants=(await pool.query<{whatsapp_partner_pending_tenants:string}>('SELECT * FROM whatsapp_partner_pending_tenants()')).rows;
  for(const {whatsapp_partner_pending_tenants:t} of tenants) {
    if(ports.enabled()) {
      const ids=await withTenant(pool,t,async c=>(await c.query<{id:string}>(`SELECT id FROM whatsapp_partner_invitations i WHERE tenant_id=$1 AND (phase IN ('creating','provisioning') OR (phase='pending' AND provider_status='pending' AND expires_at<=now()) OR EXISTS (SELECT 1 FROM whatsapp_partner_events e WHERE e.tenant_id=i.tenant_id AND e.invitation_id=i.id AND e.processed_at IS NULL)) ORDER BY updated_at LIMIT 20`,[t])).rows);
      for(const {id} of ids)try{await processPartnerInvitation(pool,t,id,ports);}catch{await withTenant(pool,t,async c=>{await c.query("UPDATE whatsapp_partner_invitations SET error_code='PARTNER_PROVIDER_FAILED',updated_at=now() WHERE tenant_id=$1 AND id=$2",[t,id]);await audit(c,{tenant_id:t,id},'whatsapp.invitation.refresh_failed','error');});}
    }
    await cleanupPartnerSecrets(pool,t,ports);
  }
}
export async function cleanupPartnerSecrets(pool:Pool,t:string,ports:PartnerPorts) {
  await withTenant(pool,t,async c=>{
    const pending=await c.query<{secret_id:string;invitation_id:string}>(`SELECT secret_id,invitation_id FROM whatsapp_partner_secrets WHERE tenant_id=$1 AND destroy_pending AND created_at<now()-interval '15 minutes' ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`,[t]);
    for(const row of pending.rows) {
      await c.query('SAVEPOINT partner_cleanup');
      try {
        await ports.secrets.deleteSecret(row.secret_id);
        await c.query('DELETE FROM whatsapp_partner_secrets WHERE tenant_id=$1 AND secret_id=$2',[t,row.secret_id]);
        await audit(c,{tenant_id:t,id:row.invitation_id},'whatsapp.secret.destroyed');
      }catch{
        await c.query('ROLLBACK TO SAVEPOINT partner_cleanup');
        await c.query('UPDATE whatsapp_partner_secrets SET created_at=now() WHERE tenant_id=$1 AND secret_id=$2',[t,row.secret_id]);
        await audit(c,{tenant_id:t,id:row.invitation_id},'whatsapp.secret.destroy_failed','error');
      }finally{await c.query('RELEASE SAVEPOINT partner_cleanup');}
    }
  });
}
