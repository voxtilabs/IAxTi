import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import type { ModuleRegistry } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { grantGoogleDelUsuario, iniciarGoogleConsent, completarGoogleConsent, conGoogleConsent, revocarGoogleConsent,
  type GoogleAudit, type GoogleCallbackInput, type GoogleGrant } from '@iaxti/module-identity';
import type { GoogleDriveFile } from '@iaxti/google';
import type * as Knowledge from '@iaxti/module-knowledge';
import { accountKey, authorizeDrive, authorizeDriveContext, denied, type DriveContext } from './drive-access';
import { driveDesdeEntorno, type DriveDeps } from './drive-config';

export const driveAudit:GoogleAudit=async(c,e)=>writeAudit(c,{...e,resource:'google_drive',actorKind:e.actor==='system'?'system':'user'});
export interface PersonalDriveFile {id:string;fileId:string;name:string;mimeType:string;url:string;aiAllowed:boolean}
function mapFile(row:Record<string,unknown>):PersonalDriveFile{return {id:String(row.id),fileId:String(row.file_id),name:String(row.name),mimeType:String(row.mime_type),url:String(row.web_url),aiAllowed:row.ai_allowed===true};}
export const requireDrive=(deps:DriveDeps|null)=>{if(!deps)throw new Error('Google Drive todavía no está configurado en este entorno.');return deps;};
const scope=(input:{tenantId:string;userId:string},action:string)=>({...input,service:'drive' as const,action});
async function validateFile(deps:DriveDeps,token:string,fileId:string,signal?:AbortSignal){const file=await deps.drive.get({accessToken:token,fileId,signal});if(file.trashed)throw denied();return file;}
export async function estadoDrive(pool:Pool,input:{tenantId:string;userId:string},registry:ModuleRegistry,deps=driveDesdeEntorno(registry)){
  return withTenant(pool,input.tenantId,async c=>{
    await authorizeDrive(c,input,registry,'integrations.read');const grant=await grantGoogleDelUsuario(c,input.tenantId,input.userId);
    return {configured:Boolean(deps),status:grant?.services.includes('drive')?grant.status:'disconnected'};
  });
}
export async function iniciarDrive(pool:Pool,input:{tenantId:string;userId:string;challenge:string},deps:DriveDeps){
  await withTenant(pool,input.tenantId,c=>authorizeDrive(c,input,deps.registry,'integrations.connect',true));
  return iniciarGoogleConsent(pool,{...input,service:'drive'},deps,driveAudit);
}
export async function completarDrive(pool:Pool,input:Omit<GoogleCallbackInput,'service'>,deps:DriveDeps){
  await completarGoogleConsent(pool,{...input,service:'drive'},deps,driveAudit,async c=>{
    await authorizeDrive(c,input,deps.registry,'integrations.connect',true);
    // Reconectar no restaura silenciosamente consentimientos de IA o copias
    // automáticas. Las referencias publicadas permanecen visibles al equipo.
    await c.query('UPDATE drive_files SET ai_allowed=false WHERE tenant_id=$1 AND user_id=$2',[input.tenantId,input.userId]);
    await c.query('UPDATE drive_contact_folders SET enabled=false,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',[input.tenantId,input.userId]);
    await c.query("UPDATE drive_uploads SET status='cancelled' WHERE tenant_id=$1 AND user_id=$2 AND status='pending'",[input.tenantId,input.userId]);
  });
  return estadoDrive(pool,input,deps.registry,deps);
}
export async function revocarDrive(pool:Pool,input:{tenantId:string;userId:string},deps:DriveDeps){
  // Revocar siempre es posible mientras conserva pertenencia y permiso,
  // aunque el negocio haya bajado de plan o esté en solo lectura.
  await withTenant(pool,input.tenantId,c=>authorizeDrive(c,input,deps.registry,'integrations.connect'));
  return revocarGoogleConsent(pool,input,deps,driveAudit);
}
export async function prepararPickerDrive(pool:Pool,input:{tenantId:string;userId:string},deps:DriveDeps){
  return withTenant(pool,input.tenantId,async c=>{
    await authorizeDrive(c,input,deps.registry,'integrations.connect',true);
    const grant=await grantGoogleDelUsuario(c,input.tenantId,input.userId);
    if(grant?.status!=='active'||!grant.services.includes('drive'))throw denied();
    await driveAudit(c,{tenantId:input.tenantId,actor:input.userId,action:'google.drive.picker.prepared',resourceId:grant.id,result:'ok'});
    // El token GIS limitado a drive.file nace solo en memoria del navegador;
    // el access token compuesto del backend jamás sale de Secret Manager.
    return {clientId:deps.clientId,...deps.picker};
  });
}
async function saveSelected(c:PoolClient,input:{tenantId:string;userId:string},grant:GoogleGrant,file:GoogleDriveFile,aiAllowed:boolean){
  const r=await c.query(`INSERT INTO drive_files(tenant_id,user_id,grant_id,account_key,file_id,name,mime_type,web_url,ai_allowed)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,user_id,file_id) DO UPDATE
    SET grant_id=EXCLUDED.grant_id,account_key=EXCLUDED.account_key,name=EXCLUDED.name,mime_type=EXCLUDED.mime_type,
      web_url=EXCLUDED.web_url,ai_allowed=EXCLUDED.ai_allowed,updated_at=now() RETURNING *`,
    [input.tenantId,input.userId,grant.id,accountKey(grant),file.id,file.name,file.mimeType,file.webViewLink,aiAllowed]);
  return mapFile(r.rows[0]);
}
export async function seleccionarArchivoDrive(pool:Pool,input:{tenantId:string;userId:string;fileId:string;aiAllowed:boolean},deps:DriveDeps){
  return conGoogleConsent(pool,scope(input,'google.drive.file.selected'),deps,driveAudit,async(c,token,grant)=>{
    const permissions=await authorizeDrive(c,input,deps.registry,'integrations.connect',true);
    if(input.aiAllowed&&(!permissions.has('knowledge.read')||!deps.registry.capability<unknown>('knowledge')))throw denied();
    const file=await validateFile(deps,token,input.fileId);if(input.aiAllowed&&!file.canDownload)throw denied();
    return saveSelected(c,input,grant,file,input.aiAllowed);
  });
}
async function ownFile(c:PoolClient,input:{tenantId:string;userId:string;id:string},grant:GoogleGrant){
  const r=await c.query(`SELECT * FROM drive_files WHERE tenant_id=$1 AND user_id=$2 AND id=$3
    AND grant_id=$4 AND account_key=$5 FOR UPDATE`,[input.tenantId,input.userId,input.id,grant.id,accountKey(grant)]);
  if(!r.rowCount)throw denied();return r.rows[0];
}
export async function permitirIaDrive(pool:Pool,input:{tenantId:string;userId:string;id:string;allowed:boolean},deps:DriveDeps){
  return conGoogleConsent(pool,scope(input,'google.drive.ai_consent.changed'),deps,driveAudit,async(c,token,grant)=>{
    const permissions=await authorizeDrive(c,input,deps.registry,'integrations.connect',true);
    if(input.allowed&&(!permissions.has('knowledge.read')||!deps.registry.capability<unknown>('knowledge')))throw denied();
    const row=await ownFile(c,input,grant);const file=await validateFile(deps,token,row.file_id);
    if(input.allowed&&!file.canDownload)throw denied();return saveSelected(c,input,grant,file,input.allowed);
  });
}
/** Cinco archivos por página, cuatro segundos de proveedor y 4.800 caracteres
 * de contenido como máximo. El cursor permite continuar sin ocultar archivos. */
export async function buscarDrive(pool:Pool|PoolClient,input:{tenantId:string;userId:string;query:string;context?:DriveContext;readDocuments?:boolean;after?:string},deps:DriveDeps){
  return conGoogleConsent(pool,scope(input,'google.drive.search'),deps,driveAudit,async(c,token,grant)=>{
    let permissions:Set<string>;
    if(input.context)({permissions}=await authorizeDriveContext(c,{...input,...input.context},deps.registry));
    else {if(input.readDocuments)throw denied();permissions=await authorizeDrive(c,input,deps.registry,'integrations.read');}
    const knowledge=permissions.has('knowledge.read')?deps.registry.capability<typeof Knowledge>('knowledge'):null;
    const query=input.query.slice(0,200).trim();
    const rows=await c.query(`SELECT * FROM drive_files WHERE tenant_id=$1 AND user_id=$2 AND grant_id=$3 AND account_key=$4
      AND ($5::uuid IS NULL OR id>$5) AND ($6::boolean OR strpos(lower(name),lower($7))>0)
      ORDER BY id LIMIT 6`,[input.tenantId,input.userId,grant.id,accountKey(grant),input.after??null,Boolean(input.readDocuments),query]);
    const result:Array<PersonalDriveFile&{available:boolean;knowledgeReadable:boolean;passages:Array<{text:string;part:number;citation:string}>}>=[];
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),4000);
    let contentLeft=4800;let last:string|null=null;let truncated=rows.rowCount!>5;
    try{for(const row of rows.rows.slice(0,5)){
      if(abort.signal.aborted){truncated=true;break;}
      const selected=mapFile(row);
      let readable=false;
      try{
        const file=await validateFile(deps,token,row.file_id,abort.signal);
        readable=['text/plain','text/markdown','text/csv','application/vnd.google-apps.document','application/vnd.google-apps.spreadsheet','application/vnd.google-apps.presentation'].includes(file.mimeType);
        await driveAudit(c,{tenantId:input.tenantId,actor:input.userId,action:'google.drive.metadata.read',resourceId:row.id,result:'ok'});
        let passages:Array<{text:string;part:number;citation:string}>=[];
        if(input.readDocuments&&selected.aiAllowed&&knowledge&&file.canDownload&&readable){
          if(contentLeft<=0){truncated=true;break;}
          const data=await deps.drive.read({accessToken:token,fileId:file.id,mimeType:file.mimeType,signal:abort.signal,maxBytes:2*1024*1024});
          await driveAudit(c,{tenantId:input.tenantId,actor:input.userId,action:'google.drive.document.read',resourceId:row.id,result:'ok'});
          if(abort.signal.aborted){truncated=true;break;}
          passages=(await knowledge.buscarDocumentoPersonal({...data,query})).map(part=>{
            const text=part.text.slice(0,contentLeft);contentLeft-=text.length;
            return {...part,text,citation:`${file.webViewLink}#iaxti-parte-${part.part}`};
          }).filter(part=>part.text.length>0);
        }
        result.push({...selected,name:file.name,mimeType:file.mimeType,url:file.webViewLink,available:true,knowledgeReadable:readable,passages});
      }catch{
        await driveAudit(c,{tenantId:input.tenantId,actor:input.userId,action:'google.drive.file.read',resourceId:row.id,result:'error'});
        if(abort.signal.aborted){truncated=true;break;}
        result.push({...selected,available:false,knowledgeReadable:readable,passages:[]});
      }
      last=selected.id;
    }}finally{clearTimeout(timer);}
    return {files:result,knowledgeAvailable:Boolean(knowledge),truncated,nextCursor:truncated?(last??input.after??null):null};
  });
}
export async function adjuntarDrive(pool:Pool|PoolClient,input:{tenantId:string;userId:string;id:string;context:DriveContext},deps:DriveDeps){
  return conGoogleConsent(pool,scope(input,'google.drive.attach'),deps,driveAudit,async(c,token,grant)=>{
    const {contactId}=await authorizeDriveContext(c,{...input,...input.context},deps.registry,true);
    const row=await ownFile(c,input,grant);const file=await validateFile(deps,token,row.file_id);
    const r=await c.query(`INSERT INTO drive_attachments(tenant_id,user_id,drive_file_id,contact_id,conversation_id,name,mime_type,web_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[input.tenantId,input.userId,input.id,contactId,input.context.conversationId??null,file.name,file.mimeType,file.webViewLink]);
    return {attached:true,created:Boolean(r.rowCount)};
  });
}
export async function adjuntosDrive(pool:Pool,input:{tenantId:string;userId:string;context:DriveContext},registry:ModuleRegistry){
  return withTenant(pool,input.tenantId,async c=>{
    const {contactId}=await authorizeDriveContext(c,{...input,...input.context},registry);
    // Referencias publicadas al contexto, no contenido ni consentimiento IA.
    return (await c.query(`SELECT a.id,a.name,a.mime_type,a.web_url,a.user_id,CASE WHEN a.user_id=$4 THEN a.drive_file_id ELSE NULL END AS selected_id FROM drive_attachments a
      WHERE a.tenant_id=$1 AND a.contact_id=$2 AND a.conversation_id IS NOT DISTINCT FROM $3::uuid
      ORDER BY a.created_at DESC LIMIT 100`,[input.tenantId,contactId,input.context.conversationId??null,input.userId])).rows
      .map(row=>({id:row.id,selectedId:row.selected_id,name:row.name,mimeType:row.mime_type,url:row.web_url,own:row.user_id===input.userId}));
  });
}
