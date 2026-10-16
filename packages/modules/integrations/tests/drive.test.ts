import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations, withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { GOOGLE_DRIVE_SCOPE } from '@iaxti/google';
import {
  iniciarGoogleConsent, completarGoogleConsent, revocarGoogleConsent,
  grantGoogleDelUsuario, type GoogleAudit,
} from '@iaxti/module-identity';
import { ModuleRegistry } from '@iaxti/core';
import * as crm from '@iaxti/module-crm';
import * as conversations from '@iaxti/module-conversations';
import * as knowledge from '@iaxti/module-knowledge';
import { seleccionarArchivoDrive, buscarDrive, adjuntarDrive, permitirIaDrive, adjuntosDrive, prepararPickerDrive } from '../application/drive';
import { configurarCarpetaDrive, driveConsumers, procesarAdjuntoDrive, guardarAdjuntosDrive } from '../application/drive-uploads';
import type { DriveDeps } from '../application/drive-config';
import type { GoogleDriveFile } from '@iaxti/google';

const database=`iaxti_drive_${randomBytes(6).toString('hex')}`;
const role=`drive_role_${randomBytes(6).toString('hex')}`;
const url=process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let control:Pool;let admin:Pool;let app:Pool;let createdRole=false;
let tenantId:string;let userId:string;let deps:DriveDeps;let contactId:string;let conversationId:string;let messageId:string;let registry:ModuleRegistry;let copies:Set<string>;let versions:Map<string,string>;
const audit:GoogleAudit=async(c,e)=>writeAudit(c,{...e,resource:'google_integration',actorKind:e.actor==='system'?'system':'user'});
beforeAll(async()=>{
  control=new Pool({connectionString:url});await control.query(`CREATE DATABASE ${database}`);
  const isolated=new URL(url);isolated.pathname=`/${database}`;admin=new Pool({connectionString:isolated.href});
  await runMigrations(admin);await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS NOSUPERUSER`);createdRole=true;
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  app=new Pool({connectionString:isolated.href,options:`-c role=${role}`,max:4});
});
afterAll(async()=>{
  await app?.end();if(admin){if(createdRole){await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);}await admin.end();}
  if(control){await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);await control.end();}
});
beforeEach(async()=>{
  tenantId=(await admin.query("INSERT INTO tenants(name,plan) VALUES('drive-test','crece') RETURNING id")).rows[0].id;
  userId=randomUUID();await admin.query("INSERT INTO user_roles(tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id IS NULL AND name='USER'",[tenantId,userId]);
  versions=new Map();let revision=0;
  const save=async(id:string,payload:string)=>{const ref=`projects/test/secrets/${id}/versions/${++revision}`;versions.set(ref,payload);return ref;};
  registry=new ModuleRegistry().load();registry.registerContract('crm',crm);registry.registerContract('conversations',conversations);registry.registerContract('knowledge',knowledge);
  copies=new Set();
  const file=(id:string)=>({id,name:`Archivo ${id}`,mimeType:'text/plain',webViewLink:`https://drive.google.com/file/d/${id}/view`,size:12,md5Checksum:null,modifiedTime:null,trashed:false,canDownload:true,parents:[],appProperties:{}} satisfies GoogleDriveFile);
  deps={registry,picker:{apiKey:'public-test-key',appId:'123456'},drive:{get:vi.fn(async({fileId})=>file(fileId)),read:vi.fn(async()=>({bytes:new TextEncoder().encode('Condiciones del servicio. Precio cincuenta.'),mimeType:'text/plain'})),generateId:vi.fn(async()=>`drive_${randomBytes(12).toString('hex')}`),createFolder:vi.fn(async input=>({...file(input.fileId),mimeType:'application/vnd.google-apps.folder'})),upload:vi.fn(async input=>{copies.add(input.fileId);return file(input.fileId);})},clientId:'test-client',oauth:{authorizationUrl:vi.fn(()=> 'https://accounts.google.com/o/oauth2/v2/auth'),
    exchange:vi.fn(async()=>({accessToken:'access',refreshToken:'refresh',expiresIn:3600,scope:['openid',GOOGLE_DRIVE_SCOPE],idToken:'signed-test'})),
    verifyIdToken:vi.fn(async()=>({sub:userId})),refresh:vi.fn(async()=>({accessToken:'renewed',expiresIn:3600,scope:[GOOGLE_DRIVE_SCOPE]})),revoke:vi.fn(async()=>{})},
    secrets:{put:vi.fn(save),addVersion:vi.fn(save),access:vi.fn(async ref=>{const saved=versions.get(ref);if(!saved)throw new Error('missing');return saved;}),destroy:vi.fn(async ref=>{versions.delete(ref);}),deleteSecret:vi.fn(async id=>{for(const ref of versions.keys())if(ref.includes(`/secrets/${id}/`))versions.delete(ref);})}};
  contactId=(await admin.query("INSERT INTO contacts(tenant_id,name,phone,origin,owner_id) VALUES($1,'Ana','+56933334444','whatsapp',$2) RETURNING id",[tenantId,userId])).rows[0].id;
  conversationId=(await admin.query("INSERT INTO conversations(tenant_id,contact_id,channel,owner_id) VALUES($1,$2,'whatsapp',$3) RETURNING id",[tenantId,contactId,userId])).rows[0].id;
  const verifier=randomBytes(32).toString('base64url');const challenge=createHash('sha256').update(verifier).digest('base64url');
  const start=await iniciarGoogleConsent(app,{tenantId,userId,service:'drive',challenge},deps,audit);
  await completarGoogleConsent(app,{tenantId,userId,service:'drive',state:start.state,nonce:start.nonce,verifier,code:'temporary'},deps,audit);
});
const who=()=>({tenantId,userId});
const context=()=>({contactId,conversationId});
const select=(fileId='file_one',aiAllowed=false)=>seleccionarArchivoDrive(app,{...who(),fileId,aiAllowed},deps);
const search=(readDocuments=false)=>buscarDrive(app,{...who(),query:'',context:context(),readDocuments},deps);
async function queue(){
  await configurarCarpetaDrive(app,{...who(),contactId,enabled:true},deps);
  messageId=(await admin.query(`INSERT INTO messages(tenant_id,conversation_id,direction,type,body,author_kind,attachments)
    VALUES($1,$2,'in','documento','Archivo','contact',$3::jsonb) RETURNING id`,[tenantId,conversationId,JSON.stringify([{key:`${tenantId}/wa/archivo.txt`,name:'archivo.txt',contentType:'text/plain',size:12}])])).rows[0].id;
  const event={id:1,requestId:null,name:'message.received',tenantId,actor:'system',occurredAt:new Date(),version:1,payload:{conversationId,contactId,messageId}};
  const consumer=driveConsumers(registry)[0];await withTenant(app,tenantId,c=>consumer.handler(event,c));
  return {event,consumer,id:(await admin.query('SELECT id FROM drive_uploads WHERE tenant_id=$1',[tenantId])).rows[0].id as string};
}
const storage={read:async()=>new TextEncoder().encode('Contenido')};
describe('Drive personal con PostgreSQL real y Google/Secret Manager sustituidos',()=>{
  it('selección acredita acceso en Google y no entrega tokens al navegador',async()=>{
    const file=await select();expect(file.fileId).toBe('file_one');expect(file.aiAllowed).toBe(false);
    expect(await prepararPickerDrive(app,who(),deps)).toEqual({clientId:'test-client',apiKey:'public-test-key',appId:'123456'});
    expect(deps.drive.get).toHaveBeenCalledWith(expect.objectContaining({fileId:'file_one'}));
    expect((await search()).files).toHaveLength(1);
    const audits=await admin.query("SELECT actor,action FROM audit_log WHERE tenant_id=$1 AND action LIKE 'google.drive.%'",[tenantId]);
    expect(audits.rows.some(row=>row.action==='google.drive.metadata.read'&&row.actor===userId)).toBe(true);
  });
  it('adivinar IDs seleccionados por otra persona/tenant no permite adjuntar ni leer',async()=>{
    const file=await select();const other=randomUUID();
    await admin.query("INSERT INTO user_roles(tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id IS NULL AND name='USER'",[tenantId,other]);
    await expect(adjuntarDrive(app,{tenantId,userId:other,id:file.id,context:context()},deps)).rejects.toThrow();
    const stranger=(await admin.query("INSERT INTO tenants(name) VALUES('stranger') RETURNING id")).rows[0].id;
    expect((await withTenant(app,stranger,c=>c.query('SELECT id FROM drive_files'))).rowCount).toBe(0);
    await expect(withTenant(app,stranger,async c=>c.query("INSERT INTO drive_files(tenant_id,user_id,grant_id,account_key,file_id,name,mime_type,web_url) SELECT $1,$2,$3,'x','evil','x','text/plain','x'",[tenantId,userId,(await admin.query('SELECT id FROM google_oauth_grants WHERE tenant_id=$1',[tenantId])).rows[0].id]))).rejects.toThrow();
  });
  it('conocer fileId no sustituye el permiso de Google ni permite seleccionar papelera',async()=>{
    vi.mocked(deps.drive.get).mockRejectedValueOnce(new Error('403'));await expect(select()).rejects.toThrow();
    const normal=await deps.drive.get({accessToken:'test',fileId:'trash'});vi.mocked(deps.drive.get).mockResolvedValueOnce({...normal,trashed:true});
    await expect(select('trash')).rejects.toThrow();expect((await admin.query('SELECT id FROM drive_files WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
  });
  it('adjuntar es idempotente, publica metadata pero no activa IA ni cambia ACL',async()=>{
    const file=await select();expect(await adjuntarDrive(app,{...who(),id:file.id,context:context()},deps)).toEqual({attached:true,created:true});
    expect(await adjuntarDrive(app,{...who(),id:file.id,context:context()},deps)).toEqual({attached:true,created:false});
    expect(await adjuntosDrive(app,{...who(),context:context()},registry)).toHaveLength(1);
    expect((await search(true)).files[0].passages).toEqual([]);expect(deps.drive.read).not.toHaveBeenCalled();
  });
  it('la lectura IA exige opt-in, conocimiento y acceso vigente al contexto',async()=>{
    const file=await select();await permitirIaDrive(app,{...who(),id:file.id,allowed:true},deps);
    expect((await search(true)).files[0].passages[0].text).toContain('Condiciones');
    expect((await admin.query('SELECT id FROM sources WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
    await admin.query('UPDATE conversations SET owner_id=$2 WHERE id=$1',[conversationId,randomUUID()]);
    await expect(search(true)).rejects.toThrow();
  });
  it('sin capability knowledge no descarga contenido personal',async()=>{
    await select('file_one',true);deps.registry=new ModuleRegistry().load();deps.registry.registerContract('crm',crm);deps.registry.registerContract('conversations',conversations);
    const result=await search(true);expect(result.knowledgeAvailable).toBe(false);expect(deps.drive.read).not.toHaveBeenCalled();
  });
  it('PDF permanece adjuntable, no envía contenido a Gemini ni otro proveedor IA',async()=>{
    const original=await deps.drive.get({accessToken:'test',fileId:'pdf'});vi.mocked(deps.drive.get).mockResolvedValue({...original,mimeType:'application/pdf'});
    await select('pdf',true);const result=await search(true);expect(result.files[0].knowledgeReadable).toBe(false);expect(result.files[0].passages).toEqual([]);expect(deps.drive.read).not.toHaveBeenCalled();
  });
  it('pagina archivos sin ocultar los antiguos y limita texto agregado',async()=>{
    for(let n=0;n<7;n++)await select(`file_${n}`,true);
    vi.mocked(deps.drive.read).mockResolvedValue({bytes:new TextEncoder().encode('texto '.repeat(2000)),mimeType:'text/plain'});
    const first=await search(true);expect(first.truncated).toBe(true);expect(first.files.flatMap(file=>file.passages).reduce((n,p)=>n+p.text.length,0)).toBeLessThanOrEqual(4800);
    expect(first.nextCursor).toBeTruthy();const second=await buscarDrive(app,{...who(),query:'',after:first.nextCursor!},deps);
    expect(second.files.length).toBeGreaterThan(0);expect(second.files.some(file=>first.files.some(old=>old.id===file.id))).toBe(false);
  });
  it('proveedor lento recibe cancelación global y devuelve parcial explícito en cuatro segundos',async()=>{
    await select();let signal:AbortSignal|undefined;
    vi.mocked(deps.drive.get).mockImplementation(input=>new Promise((_resolve,reject)=>{signal=input.signal;input.signal?.addEventListener('abort',()=>reject(new Error('abort')),{once:true});}));
    const start=Date.now();const result=await search();expect(signal?.aborted).toBe(true);expect(result.truncated).toBe(true);expect(result.files).toEqual([]);expect(Date.now()-start).toBeLessThan(6000);
  },10000);
  it('contacto ajeno y contacto que no corresponde a conversación se rechazan antes del proveedor',async()=>{
    const file=await select();vi.mocked(deps.drive.get).mockClear();
    await expect(adjuntarDrive(app,{...who(),id:file.id,context:{...context(),contactId:randomUUID()}},deps)).rejects.toThrow();
    expect(deps.drive.get).not.toHaveBeenCalled();
  });
  it('repetir evento tras activación no duplica entrega y desactivar impide copiar',async()=>{
    const queued=await queue();await withTenant(app,tenantId,c=>queued.consumer.handler(queued.event,c));
    expect((await admin.query('SELECT id FROM drive_uploads WHERE tenant_id=$1',[tenantId])).rowCount).toBe(1);
    await configurarCarpetaDrive(app,{...who(),contactId,enabled:false},deps);
    expect(await procesarAdjuntoDrive(app,{...who(),id:queued.id},deps,storage)).toBe('skipped');expect(copies.size).toBe(0);
  });
  it('sin opt-in por contacto, un mensaje recibido no crea carpeta ni cola ni llama a Google',async()=>{
    const id=(await admin.query(`INSERT INTO messages(tenant_id,conversation_id,direction,type,body,author_kind,attachments)
      VALUES($1,$2,'in','documento','Archivo','contact',$3::jsonb) RETURNING id`,[tenantId,conversationId,JSON.stringify([{key:`${tenantId}/wa/no-consent.txt`,name:'archivo.txt',contentType:'text/plain',size:12}])])).rows[0].id;
    const event={id:1,requestId:null,name:'message.received',tenantId,actor:'system',occurredAt:new Date(),version:1,payload:{conversationId,contactId,messageId:id}};
    await withTenant(app,tenantId,c=>driveConsumers(registry)[0].handler(event,c));
    expect((await admin.query('SELECT id FROM drive_uploads WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM drive_contact_folders WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
    expect(deps.drive.generateId).not.toHaveBeenCalled();expect(deps.drive.upload).not.toHaveBeenCalled();
  });
  it('persistir IDs antes del efecto remoto permite recuperarse de rollback sin duplicar archivo',async()=>{
    const queued=await queue();await admin.query(`CREATE FUNCTION fail_drive_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='uploaded' THEN RAISE EXCEPTION 'crash after remote upload'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER drive_crash BEFORE UPDATE ON drive_uploads FOR EACH ROW EXECUTE FUNCTION fail_drive_update()');
    try{await expect(procesarAdjuntoDrive(app,{...who(),id:queued.id},deps,storage)).rejects.toThrow();}
    finally{await admin.query('DROP TRIGGER drive_crash ON drive_uploads');await admin.query('DROP FUNCTION fail_drive_update()');}
    expect(copies.size).toBe(1);const before=(await admin.query('SELECT status,google_file_id FROM drive_uploads WHERE id=$1',[queued.id])).rows[0];expect(before.status).toBe('pending');expect(before.google_file_id).toBeTruthy();
    expect(await procesarAdjuntoDrive(app,{...who(),id:queued.id},deps,storage)).toBe('uploaded');expect(copies.size).toBe(1);expect(deps.drive.generateId).toHaveBeenCalledTimes(2);
  });
  it('retención/supresión que borró el mensaje elimina el pendiente y no copia bytes',async()=>{
    const queued=await queue();await admin.query('DELETE FROM messages WHERE id=$1',[messageId]);
    expect(await procesarAdjuntoDrive(app,{...who(),id:queued.id},deps,storage)).toBe('skipped');expect(copies.size).toBe(0);
  });
  it('revocación bloquea todos los accesos y consumidor limpia consentimientos propios',async()=>{
    await select('file_one',true);const queued=await queue();await revocarGoogleConsent(app,who(),deps,audit);
    await expect(search(true)).rejects.toThrow();const grant=await withTenant(app,tenantId,c=>grantGoogleDelUsuario(c,tenantId,userId));
    await withTenant(app,tenantId,c=>driveConsumers(registry)[1].handler({...queued.event,name:'integration.revoked',payload:{provider:'google',userId,grantId:grant!.id}},c));
    expect((await admin.query('SELECT ai_allowed FROM drive_files WHERE tenant_id=$1',[tenantId])).rows[0].ai_allowed).toBe(false);
    expect((await admin.query('SELECT status FROM drive_uploads WHERE id=$1',[queued.id])).rows[0].status).toBe('cancelled');
  });
  it('worker persiste reintento, continúa otros trabajos y no barre tenants sin pendientes',async()=>{
    await queue();vi.mocked(deps.drive.upload).mockRejectedValueOnce(new Error('timeout'));
    const result=await guardarAdjuntosDrive(app,deps,storage);expect(result.failed).toBe(1);
    const pending=(await admin.query('SELECT attempts,next_attempt_at>now() AS later FROM drive_uploads WHERE tenant_id=$1',[tenantId])).rows[0];expect(pending).toEqual({attempts:1,later:true});
    expect(await guardarAdjuntosDrive(app,deps,storage)).toEqual({uploaded:0,skipped:0,failed:0});
  });
});

describe('supresión coordinada con Drive',()=>{
  const suppress=()=>withTenant(app,tenantId,c=>crm.suprimirTitular(c,{tenantId,contactId,actor:userId,motivo:'Solicitud del titular',almacen:{borrar:async keys=>({borradas:keys,fallidas:[]})}}));
  it('marca durable niega referencias y activación antes de procesar outbox; limpieza idempotente',async()=>{
    const file=await select();await adjuntarDrive(app,{...who(),id:file.id,context:context()},deps);await queue();
    await suppress();
    await expect(adjuntosDrive(app,{...who(),context:context()},registry)).rejects.toThrow();
    await expect(configurarCarpetaDrive(app,{...who(),contactId,enabled:true},deps)).rejects.toThrow();
    const raw=(await admin.query("SELECT * FROM outbox WHERE tenant_id=$1 AND name='contact.anonymized'",[tenantId])).rows[0];
    expect(raw).toBeTruthy();
    const event={id:1,requestId:null,name:'contact.anonymized',tenantId,actor:userId,occurredAt:new Date(),version:1,payload:{contactId}};
    const consumer=driveConsumers(registry)[2];await withTenant(app,tenantId,c=>consumer.handler(event,c));await withTenant(app,tenantId,c=>consumer.handler(event,c));
    expect((await admin.query('SELECT id FROM drive_attachments WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM drive_contact_folders WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
  });
  it('una copia activa termina antes de supresión y no se reanuda después; coordinación por locks SQL',async()=>{
    const queued=await queue();let entered!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
    const upload=procesarAdjuntoDrive(app,{...who(),id:queued.id},deps,{read:async()=>{entered();await barrier;return new TextEncoder().encode('Contenido');}});
    await reached;let pid=0;let started!:()=>void;const suppressStarted=new Promise<void>(resolve=>{started=resolve;});
    const removal=withTenant(app,tenantId,async c=>{pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;started();return crm.suprimirTitular(c,{tenantId,contactId,actor:userId,motivo:'Solicitud del titular',almacen:{borrar:async keys=>({borradas:keys,fallidas:[]})}});});
    await suppressStarted;
    try{const deadline=Date.now()+3000;for(;;){const blocked=(await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;if(blocked)break;if(Date.now()>deadline)throw new Error('La supresión no esperó el lock de contacto');await new Promise(resolve=>setTimeout(resolve,10));}}
    finally{release();}
    expect(await upload).toBe('uploaded');await removal;expect(copies.size).toBe(1);
    await expect(search(true)).rejects.toThrow();expect(await procesarAdjuntoDrive(app,{...who(),id:queued.id},deps,storage)).toBe('skipped');expect(copies.size).toBe(1);
  });
});
