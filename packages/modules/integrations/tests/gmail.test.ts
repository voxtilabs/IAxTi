import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {runMigrations,withTenant} from '@iaxti/db';
import {getContactMailAccess,createContact,suprimirTitular} from '@iaxti/module-crm';
import {ModuleRegistry} from '@iaxti/core';
import {GOOGLE_GMAIL_SCOPE,GoogleIntegrationError} from '@iaxti/google';
import {iniciarGmail,completarGmail,estadoGmail,hilosGmail,revocarGmail,procesarPushGmail,autenticarPushGmail,mantenerGmail,renovarGmail,gmailConsumers,limpiarCacheGmail,type GmailContext} from '../application/gmail';
import type {GmailDeps} from '../application/gmail-config';
const url=process.env.DATABASE_URL??'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const role=`gmail_test_${randomBytes(6).toString('hex')}`;
let admin:Pool;let app:Pool;let tenantId:string;let other:string;let userId:string;let contactId:string;let email:string|null;let deps:GmailDeps;let ctx:GmailContext;let versions:Map<string,string>;let tick:Date;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
beforeAll(async()=>{admin=new Pool({connectionString:url});await runMigrations(admin);await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS NOSUPERUSER`);await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);await admin.query(`REVOKE UPDATE,DELETE ON audit_log FROM ${role}`);await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);app=new Pool({connectionString:url,options:`-c role=${role}`,max:8});});
afterAll(async()=>{await app?.end();if(admin){await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);await admin.end();}});
beforeEach(async()=>{
  tenantId=(await admin.query("INSERT INTO tenants(name,plan,state) VALUES('gmail-test','crece','active') RETURNING id")).rows[0].id;
  other=(await admin.query("INSERT INTO tenants(name,plan,state) VALUES('gmail-other','crece','active') RETURNING id")).rows[0].id;
  userId=randomUUID();contactId=randomUUID();email='ana@example.com';tick=new Date();versions=new Map();let sequence=0;
  const save=async(id:string,payload:string)=>{const ref=`projects/iaxti-test/secrets/${id}/versions/${++sequence}`;versions.set(ref,payload);return ref;};
  deps={clientId:'gmail-test-client',topicName:'projects/test-project/topics/gmail-push',subscription:'projects/test-project/subscriptions/gmail-push',ahora:()=>tick,
    oauth:{authorizationUrl:vi.fn(()=> 'https://accounts.google.com/o/oauth2/v2/auth'),exchange:vi.fn(async()=>({accessToken:'private-access',refreshToken:'private-refresh',expiresIn:3600,scope:['openid',GOOGLE_GMAIL_SCOPE],idToken:'signed'})),verifyIdToken:vi.fn(async()=>({sub:`google-${userId}`})),refresh:vi.fn(async()=>({accessToken:'refreshed',expiresIn:3600,scope:[GOOGLE_GMAIL_SCOPE]})),revoke:vi.fn(async()=>{})},
    secrets:{put:vi.fn(save),addVersion:vi.fn(save),access:vi.fn(async ref=>{const value=versions.get(ref);if(!value)throw new Error();return value;}),destroy:vi.fn(async ref=>{versions.delete(ref);}),deleteSecret:vi.fn(async id=>{for(const ref of versions.keys())if(ref.includes(`/secrets/${id}/`))versions.delete(ref);})},
    pubsub:{verify:vi.fn(async()=>{})},gmail:{profile:vi.fn(async()=>({emailAddress:`owner-${userId}@example.com`,historyId:'100'})),watch:vi.fn(async()=>({historyId:'100',expiration:tick.getTime()+6*86400000})),stop:vi.fn(async()=>{}),threads:vi.fn(async()=>({threads:[{id:'t1',subject:'Privado',snippet:'Solo mi buzón',lastMessageAt:tick.toISOString()}],truncated:false}))}};
  ctx={registry:new ModuleRegistry().load(),contact:vi.fn(async()=>({email,ownerId:userId}))};
});
async function member(t=tenantId,u=userId){await admin.query("INSERT INTO user_roles(tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE name='USER' AND tenant_id IS NULL ON CONFLICT DO NOTHING",[t,u]);}
async function attempt(t=tenantId,u=userId){await member(t,u);const verifier=randomBytes(32).toString('base64url');const start=await iniciarGmail(app,{tenantId:t,userId:u,challenge:hashChallenge(verifier)},ctx,deps);return{tenantId:t,userId:u,verifier,state:start.state,nonce:start.nonce,code:'one-use-code'};}
function hashChallenge(v:string){return createHash('sha256').update(v).digest('base64url');}
async function connect(t=tenantId,u=userId){return completarGmail(app,await attempt(t,u),ctx,deps);}
const read=(refresh=false,t=tenantId,u=userId)=>hilosGmail(app,{tenantId:t,userId:u,contactId,refresh},ctx,deps);
const push=(historyId='9007199254740993123')=>procesarPushGmail(app,{mailboxHash:hash(`owner-${userId}@example.com`),historyId,messageId:'message-test'});
describe('Gmail personal con PostgreSQL y RLS reales',()=>{
  it('acredita scope, referencias fuera de tokens y RLS A/B y sin contexto',async()=>{
    expect((await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    expect((await connect()).pushActive).toBe(true);await read();
    expect(deps.oauth.authorizationUrl).toHaveBeenCalledWith(expect.objectContaining({scopes:['openid',GOOGLE_GMAIL_SCOPE]}));
    for(const table of ['gmail_connections','gmail_thread_cache']){
      expect((await withTenant(app,other,c=>c.query(`SELECT * FROM ${table}`))).rowCount).toBe(0);expect((await app.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
    }
    const rows=(await admin.query('SELECT * FROM gmail_connections WHERE tenant_id=$1',[tenantId])).rows;
    expect(JSON.stringify(rows)).not.toMatch(/private-access|private-refresh|owner@example.com/);
  });
  it('otro usuario del mismo tenant no puede leer una caché ajena',async()=>{
    await connect();await read();const second=randomUUID();await member(tenantId,second);await expect(read(false,tenantId,second)).rejects.toThrow();
    vi.mocked(deps.oauth.verifyIdToken).mockResolvedValue({sub:'different-sub'});await connect(tenantId,second);
    vi.mocked(ctx.contact!).mockResolvedValue({email,ownerId:second});
    vi.mocked(deps.gmail.threads).mockResolvedValue({threads:[],truncated:false});expect((await read(false,tenantId,second)).threads).toEqual([]);vi.mocked(ctx.contact!).mockResolvedValue({email,ownerId:userId});expect((await read()).threads[0].subject).toBe('Privado');
  });
  it('scope parcial, replay y callback de otra persona no intercambian acceso',async()=>{
    const a=await attempt();await expect(completarGmail(app,{...a,userId:randomUUID()},ctx,deps)).rejects.toThrow();expect(deps.oauth.exchange).not.toHaveBeenCalled();
    vi.mocked(deps.oauth.exchange).mockResolvedValue({accessToken:'t',refreshToken:'r',expiresIn:60,scope:['openid'],idToken:'id'});
    await expect(completarGmail(app,a,ctx,deps)).rejects.toThrow();await expect(completarGmail(app,a,ctx,deps)).rejects.toThrow();expect(deps.secrets.put).not.toHaveBeenCalled();
  });
  it('audita lectura viva y caché sin copiar asunto/extracto/correo',async()=>{
    await connect();expect((await read()).cached).toBe(false);expect((await read()).cached).toBe(true);expect(deps.gmail.threads).toHaveBeenCalledTimes(1);
    const entries=(await admin.query("SELECT * FROM audit_log WHERE tenant_id=$1 AND action='google.gmail.threads'",[tenantId])).rows;
    expect(entries).toHaveLength(2);expect(entries.every(e=>e.result==='ok')).toBe(true);expect(JSON.stringify(entries)).not.toMatch(/Privado|Solo mi buzón|ana@example.com|private-access/);
  });
  it('la lectura explícita recupera un push perdido sin polling',async()=>{await connect();await read();expect((await read(true)).cached).toBe(false);expect(deps.gmail.threads).toHaveBeenCalledTimes(2);});
  it('cambiar correo no reutiliza caché y una respuesta tardía del correo anterior se rechaza',async()=>{
    await connect();await read();email='otra@example.com';expect((await read()).cached).toBe(false);expect(deps.gmail.threads).toHaveBeenLastCalledWith(expect.objectContaining({email:'otra@example.com'}));
    vi.mocked(deps.gmail.threads).mockImplementationOnce(async()=>{email='nueva@example.com';return{threads:[],truncated:false};});await expect(read(true)).rejects.toThrow();
  });
  it('sin correo no busca el buzón ni inventa un vacío de resultados',async()=>{await connect();email=null;expect((await read()).state).toBe('no_email');expect(deps.gmail.threads).not.toHaveBeenCalled();});
  it('push dup/out-of-order conserva bigint y no repite auditoría',async()=>{
    await connect();await read();expect((await push()).changed).toBe(1);expect((await push()).changed).toBe(0);expect((await push('9')).changed).toBe(0);
    expect((await admin.query('SELECT last_history FROM gmail_connections WHERE tenant_id=$1',[tenantId])).rows[0].last_history).toBe('9007199254740993123');expect((await read()).cached).toBe(false);
  });
  it('buzón compartido invalida dos tenants sin mezclar datos',async()=>{
    await connect();await connect(other,userId);await read();await read(false,other,userId);expect((await push()).changed).toBe(2);
    expect((await admin.query('SELECT * FROM gmail_thread_cache WHERE tenant_id=ANY($1)',[[tenantId,other]])).rowCount).toBe(0);
  });
  it('push concurrente espera la lectura y borra la caché recién insertada',async()=>{
    await connect();let entered!:()=>void;let release!:()=>void;const began=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
    vi.mocked(deps.gmail.threads).mockImplementationOnce(async()=>{entered();await gate;return{threads:[],truncated:false};});
    const reading=read();await began;const pushing=push();release();await reading;await pushing;
    expect((await admin.query('SELECT 1 FROM gmail_thread_cache WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
  });
  it('fallo remoto conserva auditoría y nunca devuelve caché como éxito fresco',async()=>{await connect();await read();vi.mocked(deps.gmail.threads).mockRejectedValue(new GoogleIntegrationError('GOOGLE_REQUEST_FAILED',500));await expect(read(true)).rejects.toThrow();expect((await admin.query("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='google.gmail.threads' AND result='error'",[tenantId])).rowCount).toBe(1);});
  it('401 remoto exige reautorización y bloquea incluso caché anterior',async()=>{await connect();await read();vi.mocked(deps.gmail.threads).mockRejectedValueOnce(new GoogleIntegrationError('GOOGLE_PERMISSION_DENIED',401));await expect(read(true)).rejects.toThrow();expect((await estadoGmail(app,{tenantId,userId},ctx,deps)).status).toBe('reauth_required');await expect(read()).rejects.toThrow();});
  it('revoke fallido bloquea datos; reintento exitoso borra cache en todos los grants',async()=>{await connect();await connect(other,userId);await read();await read(false,other,userId);vi.mocked(deps.oauth.revoke).mockRejectedValueOnce(new Error('secret'));await expect(revocarGmail(app,{tenantId,userId},ctx,deps)).rejects.toThrow();await expect(read()).rejects.toThrow();await revocarGmail(app,{tenantId,userId},ctx,deps);expect((await admin.query('SELECT * FROM gmail_connections WHERE tenant_id=ANY($1)',[[tenantId,other]])).rowCount).toBe(0);});
  it('permiso retirado, CRM apagado y plan Base se verifican antes de secretos/caché',async()=>{
    await connect();await read();vi.mocked(deps.secrets.access).mockClear();
    for(const id of ['webchat','automations','calendar','conversations']){if(ctx.registry.isActive(id))ctx.registry.disable(id);}ctx.registry.disable('crm');await expect(read()).rejects.toMatchObject({code:'MODULE_DISABLED'});ctx.registry.enable('crm');
    await admin.query("UPDATE tenants SET plan='base' WHERE id=$1",[tenantId]);await expect(read()).rejects.toMatchObject({code:'MODULE_NOT_IN_PLAN'});
    await admin.query("UPDATE tenants SET plan='crece' WHERE id=$1",[tenantId]);await admin.query('DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId]);await expect(read()).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(deps.secrets.access).not.toHaveBeenCalled();
  });
  it('renovar watch no lista correo ni avanza cursor; suspendido y sin permiso no renuevan',async()=>{
    await connect();await push();await admin.query('UPDATE gmail_connections SET watch_expires_at=NULL WHERE tenant_id=$1',[tenantId]);
    await renovarGmail(app,{tenantId,userId},ctx,deps);expect(deps.gmail.threads).not.toHaveBeenCalled();expect((await admin.query('SELECT last_history FROM gmail_connections WHERE tenant_id=$1',[tenantId])).rows[0].last_history).toBe('9007199254740993123');
    await admin.query("UPDATE tenants SET state='suspended' WHERE id=$1",[tenantId]);await admin.query('UPDATE gmail_connections SET watch_expires_at=NULL WHERE tenant_id=$1',[tenantId]);
    vi.mocked(deps.gmail.watch).mockClear();await mantenerGmail(app,ctx,deps);expect(deps.gmail.watch).not.toHaveBeenCalled();
  });
  it('evento revoked antiguo no borra reconexión vigente',async()=>{await connect();const grant=(await admin.query('SELECT id FROM google_oauth_grants WHERE tenant_id=$1',[tenantId])).rows[0].id;await withTenant(app,tenantId,c=>gmailConsumers().find(c=>c.event==='integration.revoked')!.handler({tenantId,payload:{provider:'google',userId,grantId:grant}} as never,c));expect((await estadoGmail(app,{tenantId,userId},ctx,deps)).status).toBe('active');});
  it('dueño cambiado durante la consulta no recibe resumen ni cachea datos',async()=>{
    await connect();vi.mocked(deps.gmail.threads).mockImplementationOnce(async()=>{vi.mocked(ctx.contact!).mockResolvedValue({email,ownerId:randomUUID()});return{threads:[],truncated:false};});
    await expect(read()).rejects.toThrow();expect((await admin.query('SELECT 1 FROM gmail_thread_cache WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
  });
  it('lease de generación anterior no figura activa y connected fuerza renovación',async()=>{
    await connect();await read();await admin.query('UPDATE google_oauth_grants SET generation=generation+1 WHERE tenant_id=$1',[tenantId]);
    expect((await estadoGmail(app,{tenantId,userId},ctx,deps)).pushActive).toBe(false);
    const grant=(await admin.query('SELECT id FROM google_oauth_grants WHERE tenant_id=$1',[tenantId])).rows[0].id;
    await withTenant(app,tenantId,c=>gmailConsumers().find(c=>c.event==='integration.connected')!.handler({tenantId,payload:{provider:'google',userId,grantId:grant}} as never,c));
    expect((await admin.query('SELECT watch_expires_at FROM gmail_connections WHERE tenant_id=$1',[tenantId])).rows[0].watch_expires_at).toBeNull();
    await renovarGmail(app,{tenantId,userId},ctx,deps);expect((await estadoGmail(app,{tenantId,userId},ctx,deps)).pushActive).toBe(true);
    await admin.query("UPDATE google_oauth_grants SET services=ARRAY['calendar'],generation=generation+1 WHERE tenant_id=$1",[tenantId]);
    expect((await estadoGmail(app,{tenantId,userId},ctx,deps)).pushActive).toBe(false);
    await withTenant(app,tenantId,c=>gmailConsumers().find(c=>c.event==='integration.connected')!.handler({tenantId,payload:{provider:'google',userId,grantId:grant}} as never,c));
    expect((await admin.query('SELECT 1 FROM gmail_connections WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
  });
  it('limpia cache vencida con tenant suspendido y módulo apagado, sin Google',async()=>{
    await connect();await read();await admin.query("UPDATE tenants SET state='suspended' WHERE id=$1",[tenantId]);
    await admin.query("UPDATE gmail_thread_cache SET expires_at=now()-interval '1 minute' WHERE tenant_id=$1",[tenantId]);ctx.registry.disable('integrations');
    vi.mocked(deps.gmail.profile).mockClear();vi.mocked(deps.gmail.watch).mockClear();vi.mocked(deps.gmail.threads).mockClear();
    expect(await limpiarCacheGmail(app)).toBeGreaterThanOrEqual(1);await mantenerGmail(app,ctx,deps);
    expect((await admin.query('SELECT 1 FROM gmail_thread_cache WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
    expect(deps.gmail.profile).not.toHaveBeenCalled();expect(deps.gmail.watch).not.toHaveBeenCalled();expect(deps.gmail.threads).not.toHaveBeenCalled();
  });
  it('contacto real: dueño/read_all y supresión niegan caché antes de secretos y del outbox',async()=>{
    await connect();const contact=await withTenant(app,tenantId,c=>createContact(c,{tenantId,name:'Gmail',email:'ana@example.com',phone:'+56979992222',ownerId:userId}));contactId=contact.id;ctx.contact=getContactMailAccess;
    await read();vi.mocked(deps.secrets.access).mockClear();
    await admin.query('UPDATE contacts SET owner_id=$2 WHERE tenant_id=$1 AND id=$3',[tenantId,randomUUID(),contactId]);
    await expect(read()).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(deps.secrets.access).not.toHaveBeenCalled();
    await admin.query("UPDATE user_roles SET role_id=(SELECT id FROM roles WHERE name='SUPERVISOR' AND tenant_id IS NULL) WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId]);
    expect((await read()).cached).toBe(true);
    await withTenant(app,tenantId,c=>suprimirTitular(c,{tenantId,contactId,actor:userId,motivo:'Ensayo',almacen:{borrar:async keys=>({borradas:keys,fallidas:[]})}}));
    vi.mocked(deps.secrets.access).mockClear();await expect(read()).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(deps.secrets.access).not.toHaveBeenCalled();
    expect((await admin.query("SELECT processed_at FROM outbox WHERE tenant_id=$1 AND name='contact.anonymized'",[tenantId])).rows[0].processed_at).toBeNull();
    await withTenant(app,tenantId,c=>gmailConsumers().find(h=>h.event==='contact.anonymized')!.handler({tenantId,payload:{contactId}} as never,c));
    expect((await admin.query('SELECT 1 FROM gmail_thread_cache WHERE tenant_id=$1 AND contact_id=$2',[tenantId,contactId])).rowCount).toBe(0);
  });
  it('supresión de otro contacto/tenant no borra caché personal ajena',async()=>{
    await connect();await connect(other,userId);await read();await read(false,other,userId);
    const consumer=gmailConsumers().find(h=>h.event==='contact.anonymized')!;
    await withTenant(app,tenantId,c=>consumer.handler({tenantId,payload:{contactId:randomUUID()}} as never,c));
    expect((await read()).cached).toBe(true);
    await withTenant(app,tenantId,c=>consumer.handler({tenantId,payload:{contactId}} as never,c));
    expect((await admin.query('SELECT 1 FROM gmail_thread_cache WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
    expect((await read(false,other,userId)).cached).toBe(true);
  });
  it('Pub/Sub exige subscription/body verificados y solo encola hash, nunca email',async()=>{const body={subscription:deps.subscription,message:{messageId:'123',data:Buffer.from(JSON.stringify({emailAddress:`owner-${userId}@example.com`,historyId:'9007199254740993123'})).toString('base64')}};expect(await autenticarPushGmail('signed-token',body,deps)).toEqual({messageId:'123',mailboxHash:hash(`owner-${userId}@example.com`),historyId:'9007199254740993123'});await expect(autenticarPushGmail('signed-token',{...body,subscription:'wrong'},deps)).rejects.toThrow();vi.mocked(deps.pubsub.verify).mockRejectedValue(new Error());await expect(autenticarPushGmail('bad',body,deps)).rejects.toThrow();});
});
