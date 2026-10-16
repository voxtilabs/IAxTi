import type { Pool, PoolClient } from 'pg';
import { withTenant, idsDeTenants } from '@iaxti/db';
import type { Consumer, ModuleRegistry } from '@iaxti/core';
import { bloquearGrantGoogle, conGoogleConsent } from '@iaxti/module-identity';
import type * as Crm from '@iaxti/module-crm';
import type * as Conversations from '@iaxti/module-conversations';
import { GOOGLE_DRIVE_MAX_UPLOAD_BYTES } from '@iaxti/google';
import type { DriveDeps } from './drive-config';
import { accountKey, authorizeDriveContext, denied } from './drive-access';
import { driveAudit } from './drive';

export interface DriveAttachmentStorage {read(tenantId:string,key:string,maxBytes:number):Promise<Uint8Array>}
export async function configurarCarpetaDrive(pool:Pool,input:{tenantId:string;userId:string;contactId:string;enabled:boolean},deps:DriveDeps){
  return conGoogleConsent(pool,{...input,service:'drive',action:'google.drive.contact_folder.changed'},deps,driveAudit,async(c,_token,grant)=>{
    await authorizeDriveContext(c,input,deps.registry,true);
    const key=accountKey(grant);
    await c.query(`INSERT INTO drive_contact_folders(tenant_id,user_id,contact_id,grant_id,account_key,enabled)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,user_id,contact_id) DO UPDATE SET
      folder_id=CASE WHEN drive_contact_folders.account_key=EXCLUDED.account_key THEN drive_contact_folders.folder_id ELSE NULL END,
      folder_ready=CASE WHEN drive_contact_folders.account_key=EXCLUDED.account_key THEN drive_contact_folders.folder_ready ELSE false END,
      grant_id=EXCLUDED.grant_id,account_key=EXCLUDED.account_key,enabled=EXCLUDED.enabled,enabled_at=now(),updated_at=now()`,
      [input.tenantId,input.userId,input.contactId,grant.id,key,input.enabled]);
    // Desactivar invalida pendientes. Activar no importa mensajes históricos.
    if(!input.enabled)await c.query(`UPDATE drive_uploads SET status='cancelled' WHERE tenant_id=$1 AND user_id=$2 AND status='pending'
      AND folder_id IN(SELECT id FROM drive_contact_folders WHERE tenant_id=$1 AND user_id=$2 AND contact_id=$3)`,[input.tenantId,input.userId,input.contactId]);
    return {enabled:input.enabled};
  });
}
export async function estadoCarpetaDrive(pool:Pool,input:{tenantId:string;userId:string;contactId:string},deps:DriveDeps){
  return withTenant(pool,input.tenantId,async c=>{
    await authorizeDriveContext(c,input,deps.registry);
    const r=await c.query(`SELECT f.enabled,f.folder_id,f.folder_ready,
      (SELECT count(*)::int FROM drive_uploads u WHERE u.tenant_id=f.tenant_id AND u.folder_id=f.id AND u.status='pending') AS pending,
      (SELECT count(*)::int FROM drive_uploads u WHERE u.tenant_id=f.tenant_id AND u.folder_id=f.id AND u.status='pending' AND u.attempts>0) AS retrying,
      (SELECT count(*)::int FROM drive_uploads u WHERE u.tenant_id=f.tenant_id AND u.folder_id=f.id AND u.status='uploaded') AS uploaded,
      (SELECT max(u.uploaded_at) FROM drive_uploads u WHERE u.tenant_id=f.tenant_id AND u.folder_id=f.id) AS last_uploaded_at,
      (SELECT min(u.next_attempt_at) FROM drive_uploads u WHERE u.tenant_id=f.tenant_id AND u.folder_id=f.id AND u.status='pending') AS next_attempt_at
      FROM drive_contact_folders f WHERE f.tenant_id=$1 AND f.user_id=$2 AND f.contact_id=$3`,[input.tenantId,input.userId,input.contactId]);
    const row=r.rows[0];return {enabled:row?.enabled??false,pending:row?.pending??0,retrying:row?.retrying??0,uploaded:row?.uploaded??0,
      lastUploadedAt:row?.last_uploaded_at?.toISOString()??null,nextAttemptAt:row?.next_attempt_at?.toISOString()??null,
      folderUrl:row?.folder_ready?`https://drive.google.com/drive/folders/${row.folder_id}`:null};
  });
}
export function driveConsumers(registry:ModuleRegistry):Consumer[]{
  return [{name:'integrations.drive_received',moduleId:'integrations',event:'message.received',handler:async(event,c)=>{
    const {conversationId,messageId,contactId}=event.payload;
    if(typeof conversationId!=='string'||typeof messageId!=='string'||typeof contactId!=='string')return;
    const crm=registry.capability<typeof Crm>('crm');
    if(!crm||await crm.contactoAnonimizado(c,event.tenantId,contactId,{bloquear:true}))return;
    const conversations=registry.capability<typeof Conversations>('conversations');if(!conversations)return;
    const conversation=await conversations.getConversation(c,event.tenantId,conversationId);
    if(conversation.contactId!==contactId)throw denied();
    const message=await conversations.mensajeRecibidoConAdjuntos(c,{tenantId:event.tenantId,conversationId,messageId});
    if(!message)return;
    const folders=await c.query(`SELECT id,user_id FROM drive_contact_folders WHERE tenant_id=$1 AND contact_id=$2 AND enabled AND enabled_at<=$3`,[event.tenantId,contactId,message.createdAt]);
    let created=0;
    for(const folder of folders.rows)for(const attachment of message.attachments){
      if(!attachment.key.startsWith(`${event.tenantId}/`))throw denied();
      const r=await c.query(`INSERT INTO drive_uploads(tenant_id,user_id,folder_id,conversation_id,message_id,attachment_key,name,mime_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [event.tenantId,folder.user_id,folder.id,conversationId,messageId,attachment.key,attachment.name,attachment.contentType]);
      created+=r.rowCount??0;
    }
    if(created)await driveAudit(c,{tenantId:event.tenantId,actor:'system',action:'google.drive.upload.queued',resourceId:messageId,result:'ok',metadata:{count:created}});
  }},{name:'integrations.drive_revoked',moduleId:'integrations',event:'integration.revoked',handler:async(event,c)=>{
    const {provider,userId,grantId}=event.payload;if(provider!=='google'||typeof userId!=='string'||typeof grantId!=='string')return;
    const grant=await bloquearGrantGoogle(c,{tenantId:event.tenantId,userId,noEsperar:true});
    if(!grant||grant.id!==grantId||grant.status!=='revoked')return;
    await c.query('UPDATE drive_files SET ai_allowed=false WHERE tenant_id=$1 AND user_id=$2',[event.tenantId,userId]);
    await c.query('UPDATE drive_contact_folders SET enabled=false,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[event.tenantId,userId]);
    await c.query("UPDATE drive_uploads SET status='cancelled' WHERE tenant_id=$1 AND user_id=$2 AND status='pending'",[event.tenantId,userId]);
    await driveAudit(c,{tenantId:event.tenantId,actor:'system',action:'google.drive.revoked',resourceId:grantId,result:'ok'});
  }},{name:'integrations.drive_anonymized',moduleId:'integrations',event:'contact.anonymized',handler:async(event,c)=>{
    const {contactId}=event.payload;if(typeof contactId!=='string')return;
    const crm=registry.capability<typeof Crm>('crm');if(!crm||!await crm.contactoAnonimizado(c,event.tenantId,contactId,{bloquear:true}))return;
    await c.query('DELETE FROM drive_attachments WHERE tenant_id=$1 AND contact_id=$2',[event.tenantId,contactId]);
    await c.query('DELETE FROM drive_contact_folders WHERE tenant_id=$1 AND contact_id=$2',[event.tenantId,contactId]);
    await driveAudit(c,{tenantId:event.tenantId,actor:'system',action:'google.drive.contact.anonymized',resourceId:contactId,result:'ok'});
  }}];
}
async function lockedUpload(c:PoolClient,tenantId:string,userId:string,id:string,registry:ModuleRegistry){
  const target=await c.query(`SELECT f.contact_id,u.conversation_id FROM drive_uploads u JOIN drive_contact_folders f ON f.id=u.folder_id AND f.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.user_id=$2 AND u.id=$3 AND u.status='pending'`,[tenantId,userId,id]);
  if(!target.rowCount)return null;
  await authorizeDriveContext(c,{tenantId,userId,contactId:target.rows[0].contact_id,conversationId:target.rows[0].conversation_id},registry,true);
  // Misma cuenta → contacto → carpeta → entrega en preparación y ejecución.
  const folder=await c.query(`SELECT f.* FROM drive_contact_folders f JOIN drive_uploads u ON u.folder_id=f.id AND u.tenant_id=f.tenant_id
    WHERE u.tenant_id=$1 AND u.user_id=$2 AND u.id=$3 FOR UPDATE OF f`,[tenantId,userId,id]);
  const upload=await c.query("SELECT * FROM drive_uploads WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND status='pending' FOR UPDATE",[tenantId,userId,id]);
  return folder.rowCount&&upload.rowCount?{folder:folder.rows[0],upload:upload.rows[0]}:null;
}
export async function procesarAdjuntoDrive(pool:Pool,input:{tenantId:string;userId:string;id:string},deps:DriveDeps,storage:DriveAttachmentStorage):Promise<'uploaded'|'skipped'>{
  const prepared=await conGoogleConsent(pool,{...input,service:'drive',action:'google.drive.upload.prepared'},deps,driveAudit,async(c,token,grant)=>{
    const locked=await lockedUpload(c,input.tenantId,input.userId,input.id,deps.registry);if(!locked)return false;
    const {folder,upload}=locked;
    if(!folder.enabled||folder.grant_id!==grant.id||folder.account_key!==accountKey(grant)){
      await c.query("UPDATE drive_uploads SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[input.tenantId,input.id]);return false;
    }
    await authorizeDriveContext(c,{...input,contactId:folder.contact_id,conversationId:upload.conversation_id},deps.registry,true);
    if(!folder.folder_id){const id=await deps.drive.generateId({accessToken:token});await c.query('UPDATE drive_contact_folders SET folder_id=$3 WHERE tenant_id=$1 AND id=$2',[input.tenantId,folder.id,id]);}
    if(!upload.google_file_id){const id=await deps.drive.generateId({accessToken:token});await c.query('UPDATE drive_uploads SET google_file_id=$3 WHERE tenant_id=$1 AND id=$2',[input.tenantId,input.id,id]);}
    return true;
  });
  if(!prepared)return 'skipped';
  // IDs confirmados ANTES de crear nada en Drive. Si un commit o respuesta
  // queda incierto, repetir el mismo ID produce 409 y se valida su metadata.
  return conGoogleConsent(pool,{...input,service:'drive',action:'google.drive.upload.completed'},deps,driveAudit,async(c,token,grant)=>{
    const locked=await lockedUpload(c,input.tenantId,input.userId,input.id,deps.registry);if(!locked)return 'skipped';
    const {folder,upload}=locked;
    if(!folder.enabled||folder.grant_id!==grant.id||folder.account_key!==accountKey(grant)){
      await c.query("UPDATE drive_uploads SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[input.tenantId,input.id]);return 'skipped';
    }
    const {contactName}=await authorizeDriveContext(c,{...input,contactId:folder.contact_id,conversationId:upload.conversation_id},deps.registry,true);
    const conversations=deps.registry.capability<typeof Conversations>('conversations');if(!conversations)throw denied();
    const message=await conversations.mensajeRecibidoConAdjuntos(c,{tenantId:input.tenantId,conversationId:upload.conversation_id,messageId:upload.message_id});
    if(!message?.attachments.some(attachment=>attachment.key===upload.attachment_key)){
      await c.query("UPDATE drive_uploads SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[input.tenantId,input.id]);return 'skipped';
    }
    if(!folder.folder_id||!upload.google_file_id||!String(upload.attachment_key).startsWith(`${input.tenantId}/`))throw denied();
    if(!folder.folder_ready){
      await deps.drive.createFolder({accessToken:token,fileId:folder.folder_id,name:`${contactName} · IAxTi`,marker:folder.id});
      await c.query('UPDATE drive_contact_folders SET folder_ready=true WHERE tenant_id=$1 AND id=$2',[input.tenantId,folder.id]);
    }
    const bytes=await storage.read(input.tenantId,upload.attachment_key,GOOGLE_DRIVE_MAX_UPLOAD_BYTES);
    if(bytes.byteLength>GOOGLE_DRIVE_MAX_UPLOAD_BYTES)throw denied();
    await deps.drive.upload({accessToken:token,fileId:upload.google_file_id,folderId:folder.folder_id,name:upload.name,mimeType:upload.mime_type,bytes,marker:upload.id});
    await c.query("UPDATE drive_uploads SET status='uploaded',uploaded_at=now() WHERE tenant_id=$1 AND id=$2",[input.tenantId,input.id]);
    return 'uploaded';
  });
}
export async function guardarAdjuntosDrive(pool:Pool,deps:DriveDeps,storage:DriveAttachmentStorage){
  const result={uploaded:0,skipped:0,failed:0};if(!deps.registry.isActive('integrations'))return result;
  const ids=(await pool.query<{tenant_id:string}>('SELECT tenant_id FROM tenants_con_adjuntos_drive()')).rows.map(row=>row.tenant_id);
  for(const tenantId of await idsDeTenants(pool,{ids})){
    const jobs=await withTenant(pool,tenantId,async c=>(await c.query("SELECT id,user_id FROM drive_uploads WHERE tenant_id=$1 AND status='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT 20",[tenantId])).rows);
    for(const row of jobs){try{result[await procesarAdjuntoDrive(pool,{tenantId,userId:row.user_id,id:row.id},deps,storage)]++;}
      catch{
        result.failed++;
        await withTenant(pool,tenantId,async c=>{
          await c.query(`UPDATE drive_uploads SET attempts=attempts+1,next_attempt_at=now()+make_interval(secs=>LEAST(3600,60*power(2,LEAST(attempts,6)))::int)
            WHERE tenant_id=$1 AND id=$2 AND status='pending'`,[tenantId,row.id]);
          await driveAudit(c,{tenantId,actor:'system',action:'google.drive.upload.failed',resourceId:row.id,result:'error'});
        });
      }
    }
  }
  return result;
}
