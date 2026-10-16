import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { runMigrations, withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { GOOGLE_CALENDAR_SCOPE, GOOGLE_DRIVE_SCOPE } from '@iaxti/google';
import {
  iniciarGoogleConsent, completarGoogleConsent, conGoogleConsent, revocarGoogleConsent,
  grantGoogleDelUsuario, type GoogleConsentDeps, type GoogleService, type GoogleAudit,
} from '@iaxti/module-identity';
import { estadoGoogleCalendar, huecosConGoogle } from '../application/google';
import { googleCalendarConsumers } from '../application/google-revoked';
import type { CalendarGoogleDeps } from '../application/google-config';

const database=`iaxti_google_services_${randomBytes(6).toString('hex')}`;
const role=`google_services_${randomBytes(6).toString('hex')}`;
const url=process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let control:Pool;let admin:Pool;let app:Pool;let createdRole=false;
let tenantId:string;let userId:string;let deps:GoogleConsentDeps;let versions:Map<string,string>;
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
  tenantId=(await admin.query("INSERT INTO tenants(name) VALUES('google-services') RETURNING id")).rows[0].id;
  userId=randomUUID();await admin.query("INSERT INTO user_roles(tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id IS NULL AND name='USER'",[tenantId,userId]);
  versions=new Map();let revision=0;
  const save=async(id:string,payload:string)=>{const ref=`projects/test/secrets/${id}/versions/${++revision}`;versions.set(ref,payload);return ref;};
  deps={clientId:'test-client',oauth:{authorizationUrl:vi.fn(()=> 'https://accounts.google.com/o/oauth2/v2/auth'),
    exchange:vi.fn(async()=>({accessToken:'access',refreshToken:'refresh',expiresIn:3600,scope:['openid',GOOGLE_CALENDAR_SCOPE],idToken:'signed-test'})),
    verifyIdToken:vi.fn(async()=>({sub:userId})),refresh:vi.fn(async()=>({accessToken:'renewed',expiresIn:3600,scope:[GOOGLE_CALENDAR_SCOPE,GOOGLE_DRIVE_SCOPE]})),revoke:vi.fn(async()=>{})},
    secrets:{put:vi.fn(save),addVersion:vi.fn(save),access:vi.fn(async ref=>{const saved=versions.get(ref);if(!saved)throw new Error('missing');return saved;}),destroy:vi.fn(async ref=>{versions.delete(ref);}),deleteSecret:vi.fn(async id=>{for(const ref of versions.keys())if(ref.includes(`/secrets/${id}/`))versions.delete(ref);})}};
});
async function attempt(service:GoogleService){
  const verifier=randomBytes(32).toString('base64url');const challenge=createHash('sha256').update(verifier).digest('base64url');
  const start=await iniciarGoogleConsent(app,{tenantId,userId,service,challenge},deps,audit);
  return {tenantId,userId,service,state:start.state,nonce:start.nonce,verifier,code:'temporary-code'};
}
async function connect(service:GoogleService,scopes:string[],refreshToken:string|undefined='refresh'){
  vi.mocked(deps.oauth.exchange).mockResolvedValue({accessToken:'combined-access',refreshToken,expiresIn:3600,scope:scopes,idToken:'signed-test'});
  await completarGoogleConsent(app,await attempt(service),deps,audit);
}
const grant=()=>withTenant(app,tenantId,c=>grantGoogleDelUsuario(c,tenantId,userId));
const read=(service:GoogleService)=>conGoogleConsent(app,{tenantId,userId,service,action:`google.${service}.read`},deps,audit,async()=>true);

describe('consentimiento incremental compartido Calendar/Drive',()=>{
  it('añade solo drive.file y conserva una referencia efectiva para ambos servicios',async()=>{
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);const previous=await grant();
    await connect('drive',['openid',GOOGLE_CALENDAR_SCOPE,GOOGLE_DRIVE_SCOPE],undefined);
    const current=await grant();expect(current?.id).toBe(previous?.id);expect(current?.services).toEqual(['calendar','drive']);
    expect(current?.secretRef).not.toBe(previous?.secretRef);expect(JSON.parse(versions.get(current!.secretRef)!).refreshToken).toBe('refresh');
    expect(deps.oauth.authorizationUrl).toHaveBeenLastCalledWith(expect.objectContaining({scopes:['openid',GOOGLE_DRIVE_SCOPE,GOOGLE_CALENDAR_SCOPE]}));
    expect(await read('calendar')).toBe(true);expect(await read('drive')).toBe(true);
    expect((await admin.query('SELECT count(*)::int AS n FROM google_oauth_grants WHERE tenant_id=$1',[tenantId])).rows[0].n).toBe(1);
  });
  it('un permiso parcial conserva intactos token, scopes y servicios anteriores',async()=>{
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);const previous=await grant();
    await expect(connect('drive',['openid',GOOGLE_DRIVE_SCOPE])).rejects.toThrow();
    expect(await grant()).toEqual(previous);expect(deps.secrets.put).toHaveBeenCalledTimes(1);
    expect(await read('calendar')).toBe(true);await expect(read('drive')).rejects.toThrow();
  });
  it('dos pantallas de distintos servicios no invalidan intentos, pero cada callback exige su servicio',async()=>{
    const calendar=await attempt('calendar');const drive=await attempt('drive');
    await expect(completarGoogleConsent(app,{...drive,service:'calendar'},deps,audit)).rejects.toThrow(/expiró/);
    await completarGoogleConsent(app,calendar,deps,audit);
    vi.mocked(deps.oauth.exchange).mockResolvedValue({accessToken:'new',refreshToken:'refresh',expiresIn:3600,scope:['openid',GOOGLE_CALENDAR_SCOPE,GOOGLE_DRIVE_SCOPE],idToken:'signed-test'});
    await completarGoogleConsent(app,drive,deps,audit);expect((await grant())?.services).toHaveLength(2);
  });
  it('un callback antiguo no elimina un permiso que otro callback acaba de añadir',async()=>{
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);const stale=await attempt('calendar');
    await connect('drive',['openid',GOOGLE_CALENDAR_SCOPE,GOOGLE_DRIVE_SCOPE]);const previous=await grant();
    vi.mocked(deps.oauth.exchange).mockResolvedValue({accessToken:'old',refreshToken:'old',expiresIn:3600,scope:['openid',GOOGLE_CALENDAR_SCOPE],idToken:'signed-test'});
    await expect(completarGoogleConsent(app,stale,deps,audit)).rejects.toThrow();expect(await grant()).toEqual(previous);
  });
  it('Drive por sí solo no activa Calendar ni impide la agenda local Base',async()=>{
    await connect('drive',['openid',GOOGLE_DRIVE_SCOPE]);
    const calendarDeps={...deps,webhookAddress:'https://example.test/calendar',calendar:{freebusy:vi.fn(),watch:vi.fn(),stop:vi.fn()}} satisfies CalendarGoogleDeps;
    expect((await estadoGoogleCalendar(app,{tenantId,userId},calendarDeps)).status).toBe('disconnected');
    expect(await huecosConGoogle(app,{tenantId,ownerId:userId,dia:'2030-01-01'},calendarDeps)).toEqual([]);
    expect(calendarDeps.calendar.freebusy).not.toHaveBeenCalled();await expect(read('calendar')).rejects.toThrow();
  });
  it('un refresh parcial nunca sustituye el token combinado vigente',async()=>{
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);await connect('drive',['openid',GOOGLE_CALENDAR_SCOPE,GOOGLE_DRIVE_SCOPE]);
    const previous=await grant();const saved=JSON.parse(versions.get(previous!.secretRef)!);saved.expiresAt=0;versions.set(previous!.secretRef,JSON.stringify(saved));
    vi.mocked(deps.oauth.refresh).mockResolvedValue({accessToken:'partial',expiresIn:3600,scope:[GOOGLE_DRIVE_SCOPE]});
    await expect(read('drive')).rejects.toThrow();expect((await grant())?.secretRef).toBe(previous?.secretRef);expect(deps.secrets.addVersion).not.toHaveBeenCalled();
  });
  it('revocar desde cualquier servicio bloquea ambos aunque falle el proveedor',async()=>{
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);await connect('drive',['openid',GOOGLE_CALENDAR_SCOPE,GOOGLE_DRIVE_SCOPE]);
    vi.mocked(deps.oauth.revoke).mockRejectedValue(new Error('temporary outage'));
    await expect(revocarGoogleConsent(app,{tenantId,userId},deps,audit)).rejects.toThrow(/bloqueado/);
    expect((await grant())?.status).toBe('revoking');await expect(read('calendar')).rejects.toThrow();await expect(read('drive')).rejects.toThrow();
  });
  it('el consumidor limpia Calendar al revocar desde Drive y omite eventos viejos después de reconectar',async()=>{
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);await connect('drive',['openid',GOOGLE_CALENDAR_SCOPE,GOOGLE_DRIVE_SCOPE]);
    await admin.query('INSERT INTO calendar_connections(id,tenant_id,user_id) VALUES($1,$2,$3)',[randomUUID(),tenantId,userId]);
    await revocarGoogleConsent(app,{tenantId,userId},deps,audit);
    const event={id:1,requestId:null,name:'integration.revoked',tenantId,actor:'system',occurredAt:new Date(),version:1,payload:{provider:'google',userId,grantId:(await grant())!.id}};
    await withTenant(app,tenantId,c=>googleCalendarConsumers()[0].handler(event,c));
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);
    await admin.query('INSERT INTO calendar_connections(id,tenant_id,user_id) VALUES($1,$2,$3)',[randomUUID(),tenantId,userId]);
    await withTenant(app,tenantId,c=>googleCalendarConsumers()[0].handler(event,c));
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE tenant_id=$1',[tenantId])).rowCount).toBe(1);
  });
  it('relee bajo cerrojo si una reconexión termina entre leer el evento y limpiar',async()=>{
    await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);
    await admin.query('INSERT INTO calendar_connections(id,tenant_id,user_id) VALUES($1,$2,$3)',[randomUUID(),tenantId,userId]);
    await revocarGoogleConsent(app,{tenantId,userId},deps,audit);
    const event={id:2,requestId:null,name:'integration.revoked',tenantId,actor:'system',occurredAt:new Date(),version:1,payload:{provider:'google',userId,grantId:(await grant())!.id}};
    let read!:()=>void;let proceed!:()=>void;
    const readOld=new Promise<void>(resolve=>{read=resolve;});const resume=new Promise<void>(resolve=>{proceed=resolve;});
    const consumer=withTenant(app,tenantId,async c=>{
      const query=c.query.bind(c);let blocked=false;
      // Intercepta solo la entrega de una lectura SQL real para fijar el
      // intercalado. No simula filas, locks, transacciones ni el callback.
      c.query=(async(sql:string,values:unknown[])=>{
        const result=await query(sql,values);
        if(!blocked&&sql.startsWith('SELECT * FROM google_oauth_grants')){blocked=true;read();await resume;}
        return result;
      }) as PoolClient['query'];
      try{await googleCalendarConsumers()[0].handler(event,c);}finally{c.query=query;}
    });
    try{
      await readOld;
      await connect('calendar',['openid',GOOGLE_CALENDAR_SCOPE]);
      const before=(await admin.query('SELECT id FROM calendar_connections WHERE tenant_id=$1',[tenantId])).rows;
      proceed();await consumer;
      expect((await admin.query('SELECT id FROM calendar_connections WHERE tenant_id=$1',[tenantId])).rows).toEqual(before);
      expect(before).toHaveLength(1);
    }finally{proceed();await consumer;}
  });
  it('rechaza pertenencia revocada antes de intercambiar o leer secretos',async()=>{
    const pending=await attempt('calendar');await admin.query('DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId]);
    await expect(completarGoogleConsent(app,pending,deps,audit)).rejects.toThrow();expect(deps.secrets.put).not.toHaveBeenCalled();
    await expect(attempt('drive')).rejects.toThrow();expect(deps.secrets.access).not.toHaveBeenCalled();
  });
});
