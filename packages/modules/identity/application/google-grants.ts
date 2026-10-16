import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';

export interface GoogleGrant {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string;
  subject: string;
  secretRef: string;
  scopes: string[];
  status: 'active' | 'revoking' | 'revoked' | 'reauth_required';
  generation: number;
}

/** El compositor aporta audit; identity no puede depender de audit (ciclo). */
export type GoogleAudit = (client: PoolClient, entry: {
  tenantId: string; actor: string; action: string; resourceId: string;
  result: 'ok' | 'error'; metadata?: Record<string, unknown>;
}) => Promise<void>;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function nombreSecreto(ref:string):string {
  const match=/^projects\/[^/]+\/secrets\/(iaxti-google-[0-9a-f-]{36})\/versions\/[1-9][0-9]*$/.exec(ref);
  if(!match)throw new Error('La referencia de custodia de Google no es válida.');
  return match[1];
}

export async function reservarSecretoGoogle(client:PoolClient,input:{tenantId:string;userId:string;secretId:string;audit:GoogleAudit}):Promise<void> {
  if(!/^iaxti-google-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.secretId))throw new Error('Identificador de secreto no válido.');
  await client.query(`INSERT INTO google_secret_versions(tenant_id,user_id,secret_ref,destroy_pending,whole_secret)
    VALUES($1,$2,$3,true,true)`,[input.tenantId,input.userId,input.secretId]);
  await input.audit(client,{tenantId:input.tenantId,actor:input.userId,action:'google.secret.reserved',resourceId:input.userId,result:'ok'});
}

function grant(row: Record<string, unknown>): GoogleGrant {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id),
    clientId: String(row.client_id), subject: String(row.google_subject),
    secretRef: String(row.secret_ref), scopes: row.scopes as string[],
    status: row.status as GoogleGrant['status'], generation: Number(row.generation),
  };
}

export async function iniciarConsentimientoGoogle(client: PoolClient, input: {
  tenantId: string; userId: string; challenge: string; ahora: Date; audit: GoogleAudit;
}): Promise<{ state: string; nonce: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) throw new Error('El desafío de conexión no es válido.');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const id = randomUUID();
  // Un intento nuevo invalida el anterior del mismo usuario y negocio.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`google-start:${input.tenantId}:${input.userId}`]);
  await client.query(`UPDATE google_oauth_attempts SET consumed_at=$3
    WHERE tenant_id=$1 AND user_id=$2 AND consumed_at IS NULL`, [input.tenantId,input.userId,input.ahora]);
  await client.query(`INSERT INTO google_oauth_attempts
    (id,tenant_id,user_id,state_hash,challenge,nonce_hash,service,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'calendar',$7)`,
  [id,input.tenantId,input.userId,hash(state),input.challenge,hash(nonce),new Date(input.ahora.getTime()+600_000)]);
  await input.audit(client,{tenantId:input.tenantId,actor:input.userId,action:'google.consent.started',resourceId:id,result:'ok'});
  return {state,nonce};
}

export async function consumirConsentimientoGoogle(client: PoolClient,input: {
  tenantId:string;userId:string;state:string;verifier:string;nonce:string;ahora:Date;
}): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)) return false;
  const challenge=createHash('sha256').update(input.verifier).digest('base64url');
  const r=await client.query(`UPDATE google_oauth_attempts SET consumed_at=$7
    WHERE tenant_id=$1 AND user_id=$2 AND state_hash=$3 AND challenge=$4 AND nonce_hash=$5
      AND service=$6 AND consumed_at IS NULL AND expires_at>$7 RETURNING id`,
  [input.tenantId,input.userId,hash(input.state),challenge,hash(input.nonce),'calendar',input.ahora]);
  return r.rowCount===1;
}

export async function grantGoogleDelUsuario(client:PoolClient,tenantId:string,userId:string):Promise<GoogleGrant|null> {
  const r=await client.query('SELECT * FROM google_oauth_grants WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId]);
  return r.rowCount ? grant(r.rows[0]) : null;
}

export async function bloquearGrantGoogle(client:PoolClient,input:{tenantId:string;userId:string;noEsperar?:boolean}):Promise<GoogleGrant|null> {
  const current=await grantGoogleDelUsuario(client,input.tenantId,input.userId);
  if(!current)return null;
  const key=`google:${current.clientId}:${current.subject}`;
  if(input.noEsperar){
    const lock=await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key]);
    if(!lock.rows[0].acquired)throw new Error('La conexión de Google se está actualizando. Reintenta la consulta.');
  }else{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  }
  const r=await client.query('SELECT * FROM google_oauth_grants WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[input.tenantId,input.userId]);
  if(!r.rowCount)return null;
  const locked=grant(r.rows[0]);
  if(locked.clientId!==current.clientId || locked.subject!==current.subject){
    throw new Error('La conexión de Google cambió. Reintenta la consulta.');
  }
  return locked;
}

export async function guardarGrantGoogle(client:PoolClient,input:{
  tenantId:string;userId:string;clientId:string;subject:string;secretRef:string;scopes:string[];audit:GoogleAudit;
}):Promise<GoogleGrant> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`google:${input.clientId}:${input.subject}`]);
  const pending=await client.query('SELECT google_revocacion_pendiente($1,$2) AS pending',[input.clientId,input.subject]);
  if(pending.rows[0].pending)throw new Error('La revocación de Google sigue pendiente. Reinténtala antes de conectar.');
  const current=await grantGoogleDelUsuario(client,input.tenantId,input.userId);
  if(current && current.status!=='revoked' && (current.clientId!==input.clientId || current.subject!==input.subject)){
    throw new Error('Revoca la cuenta de Google conectada antes de elegir otra.');
  }
  const r=await client.query(`INSERT INTO google_oauth_grants
    (id,tenant_id,user_id,client_id,google_subject,secret_ref,scopes,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,'active')
    ON CONFLICT(tenant_id,user_id) DO UPDATE SET client_id=EXCLUDED.client_id,
      google_subject=EXCLUDED.google_subject, secret_ref=EXCLUDED.secret_ref,
      scopes=EXCLUDED.scopes,status='active',generation=google_oauth_grants.generation+1,
      authorized_at=now(),updated_at=now() RETURNING *`,
  [randomUUID(),input.tenantId,input.userId,input.clientId,input.subject,input.secretRef,input.scopes]);
  const saved=grant(r.rows[0]);
  await registrarVersionGoogle(client,{tenantId:input.tenantId,userId:input.userId,secretRef:input.secretRef});
  await client.query(`DELETE FROM google_secret_versions WHERE tenant_id=$1 AND user_id=$2 AND secret_ref=$3 AND whole_secret`,
    [input.tenantId,input.userId,nombreSecreto(input.secretRef)]);
  await input.audit(client,{tenantId:input.tenantId,actor:input.userId,action:'integration.connected',resourceId:saved.id,result:'ok',metadata:{provider:'google',service:'calendar'}});
  await publishEvent(client,{name:'integration.connected',tenantId:input.tenantId,actor:input.userId,payload:{grantId:saved.id,userId:input.userId,provider:'google',service:'calendar'}});
  return saved;
}

export async function actualizarTokenGoogle(client:PoolClient,input:{grant:GoogleGrant;secretRef:string}):Promise<void>{
  const r=await client.query(`UPDATE google_oauth_grants SET secret_ref=$4,updated_at=now()
    WHERE id=$1 AND tenant_id=$2 AND generation=$3 AND status='active' RETURNING id`,
  [input.grant.id,input.grant.tenantId,input.grant.generation,input.secretRef]);
  if(!r.rowCount)throw new Error('La conexión de Google cambió. Vuelve a conectar.');
  await registrarVersionGoogle(client,{tenantId:input.grant.tenantId,userId:input.grant.userId,secretRef:input.secretRef});
}

export async function marcarGoogleSinConsentimiento(client:PoolClient,input:{grant:GoogleGrant;audit:GoogleAudit}):Promise<void>{
  await client.query(`UPDATE google_oauth_grants SET status='reauth_required',updated_at=now()
    WHERE id=$1 AND tenant_id=$2 AND generation=$3 AND status='active'`,[input.grant.id,input.grant.tenantId,input.grant.generation]);
  await input.audit(client,{tenantId:input.grant.tenantId,actor:input.grant.userId,action:'google.authorization.expired',resourceId:input.grant.id,result:'error'});
}

export interface GoogleRevocationTarget {id:string;tenantId:string;userId:string;secretRef:string;generation:number}

export async function prepararRevocacionGoogle(client:PoolClient,input:{tenantId:string;userId:string;audit:GoogleAudit}):Promise<GoogleRevocationTarget[]>{
  const source=await grantGoogleDelUsuario(client,input.tenantId,input.userId);
  if(!source || source.status==='revoked')return [];
  const r=await client.query('SELECT * FROM google_grants_para_revocar($1,$2)',[source.id,input.userId]);
  if(!r.rowCount)throw new Error('No se pudo iniciar la revocación de Google. Reintenta.');
  const targets=r.rows.map((row)=>({id:String(row.id),tenantId:String(row.tenant_id),userId:String(row.user_id),secretRef:String(row.secret_ref),generation:Number(row.generation)}));
  try{
    for(const target of [...targets].sort((a,b)=>a.tenantId.localeCompare(b.tenantId))){
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[target.tenantId]);
      await input.audit(client,{tenantId:target.tenantId,actor:'system',action:'google.revocation.requested',resourceId:target.id,result:'ok'});
    }
  }finally{await client.query("SELECT set_config('app.tenant_id',$1,true)",[input.tenantId]);}
  return targets;
}

export async function finalizarRevocacionGoogle(client:PoolClient,input:{target:GoogleRevocationTarget;audit:GoogleAudit}):Promise<void>{
  const t=input.target;
  const r=await client.query(`UPDATE google_oauth_grants SET status='revoked',updated_at=now()
    WHERE id=$1 AND tenant_id=$2 AND generation=$3 AND status='revoking' RETURNING id`,[t.id,t.tenantId,t.generation]);
  if(!r.rowCount)return;
  await encolarSecretoCompleto(client,{tenantId:t.tenantId,userId:t.userId,secretId:nombreSecreto(t.secretRef)});
  await client.query('UPDATE google_secret_versions SET destroy_pending=true WHERE tenant_id=$1 AND user_id=$2',[t.tenantId,t.userId]);
  await input.audit(client,{tenantId:t.tenantId,actor:'system',action:'integration.revoked',resourceId:t.id,result:'ok',metadata:{provider:'google'}});
  await publishEvent(client,{name:'integration.revoked',tenantId:t.tenantId,actor:'system',payload:{grantId:t.id,userId:t.userId,provider:'google'}});
}

async function registrarVersionGoogle(client:PoolClient,input:{tenantId:string;userId:string;secretRef:string}) {
  const previous=await client.query(`SELECT secret_ref FROM google_secret_versions WHERE tenant_id=$1 AND user_id=$2 AND NOT whole_secret`,[input.tenantId,input.userId]);
  for(const name of new Set(previous.rows.map(row=>nombreSecreto(row.secret_ref)))) {
    if(name!==nombreSecreto(input.secretRef)) await encolarSecretoCompleto(client,{...input,secretId:name});
  }
  await client.query(`UPDATE google_secret_versions SET destroy_pending=true
    WHERE tenant_id=$1 AND user_id=$2 AND secret_ref<>$3`,[input.tenantId,input.userId,input.secretRef]);
  await client.query(`INSERT INTO google_secret_versions(tenant_id,user_id,secret_ref)
    VALUES($1,$2,$3) ON CONFLICT(secret_ref) DO UPDATE SET destroy_pending=false`,[input.tenantId,input.userId,input.secretRef]);
}

async function encolarSecretoCompleto(client:PoolClient,input:{tenantId:string;userId:string;secretId:string}) {
  await client.query(`INSERT INTO google_secret_versions(tenant_id,user_id,secret_ref,destroy_pending,whole_secret,created_at)
    VALUES($1,$2,$3,true,true,now()-interval '16 minutes')
    ON CONFLICT(secret_ref) DO UPDATE SET destroy_pending=true`,[input.tenantId,input.userId,input.secretId]);
}

/** El recolector no puede tomar una creación en curso. Si ya la recogió,
 * no se permite crear un recurso que haya perdido su intención durable. */
export async function bloquearIntentoSecretoGoogle(client:PoolClient,input:{tenantId:string;userId:string;secretId:string}):Promise<void>{
  const r=await client.query(`SELECT 1 FROM google_secret_versions
    WHERE tenant_id=$1 AND user_id=$2 AND secret_ref=$3 AND whole_secret AND destroy_pending FOR UPDATE`,
    [input.tenantId,input.userId,input.secretId]);
  if(!r.rowCount)throw new Error('El intento de conexión terminó. Inicia nuevamente desde Agenda.');
}

export async function limpiarVersionesGoogle(client:PoolClient,input:{tenantId:string;destroy:(ref:string)=>Promise<void>;deleteSecret:(id:string)=>Promise<void>;audit:GoogleAudit}):Promise<{destroyed:number;failed:number}> {
  await client.query('DELETE FROM google_oauth_attempts WHERE tenant_id=$1 AND expires_at<=now()',[input.tenantId]);
  const rows=await client.query(`SELECT secret_ref,user_id,whole_secret FROM google_secret_versions v
    WHERE v.tenant_id=$1 AND destroy_pending AND NOT EXISTS
      (SELECT 1 FROM google_oauth_grants g WHERE g.tenant_id=$1 AND g.status<>'revoked'
        AND (g.secret_ref=v.secret_ref OR (v.whole_secret AND g.secret_ref LIKE '%/secrets/'||v.secret_ref||'/versions/%')))
      AND (NOT whole_secret OR created_at<now()-interval '15 minutes')
    ORDER BY created_at,secret_ref LIMIT 100 FOR UPDATE SKIP LOCKED`,[input.tenantId]);
  const result={destroyed:0,failed:0};
  for(const row of rows.rows) {
    await client.query('SAVEPOINT google_secret_cleanup');
    try{
      if(row.whole_secret)await input.deleteSecret(row.secret_ref);
      else await input.destroy(row.secret_ref);
      await client.query('DELETE FROM google_secret_versions WHERE tenant_id=$1 AND secret_ref=$2',[input.tenantId,row.secret_ref]);
      await input.audit(client,{tenantId:input.tenantId,actor:'system',action:'google.secret.destroyed',resourceId:row.user_id,result:'ok'});
      result.destroyed++;
    }catch{
      // También recupera errores SQL: el siguiente candidato sigue en una
      // transacción válida. Nunca conserva mensajes del proveedor ni secretos.
      await client.query('ROLLBACK TO SAVEPOINT google_secret_cleanup');
      // Rotar la fecha de pendiente impide que 100 fallos permanentes oculten
      // para siempre las filas posteriores, incluso entre tipos de limpieza.
      await client.query('UPDATE google_secret_versions SET created_at=clock_timestamp() WHERE tenant_id=$1 AND secret_ref=$2',[input.tenantId,row.secret_ref]);
      await input.audit(client,{tenantId:input.tenantId,actor:'system',action:'google.secret.destroyed',resourceId:row.user_id,result:'error'});
      result.failed++;
    }finally{
      await client.query('RELEASE SAVEPOINT google_secret_cleanup');
    }
  }
  return result;
}
