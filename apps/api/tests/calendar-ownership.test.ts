import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { runMigrations, withTenant } from '@iaxti/db';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';
import { dbRoleResolver } from '../src/auth/role-resolver';

const url=process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool:Pool;let app:INestApplication;let base:string;let tenant:string;let otherTenant:string;
let sign:(userId:string)=>Promise<string>;
const user=randomUUID();const teammate=randomUUID();const supervisor=randomUUID();const outsider=randomUUID();
beforeAll(async()=>{
  pool=new Pool({connectionString:url});await runMigrations(pool);usarPool(pool);
  tenant=(await pool.query("INSERT INTO tenants(name) VALUES('calendar ownership') RETURNING id")).rows[0].id;
  otherTenant=(await pool.query("INSERT INTO tenants(name) VALUES('other ownership') RETURNING id")).rows[0].id;
  for(const [t,u,role] of [[tenant,user,'USER'],[tenant,teammate,'USER'],[tenant,supervisor,'SUPERVISOR'],[otherTenant,outsider,'USER']]){
    await pool.query('INSERT INTO user_roles(tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE name=$3 AND tenant_id IS NULL',[t,u,role]);
  }
  for(const owner of [user,teammate]){
    await pool.query(`INSERT INTO appointments(tenant_id,contact_id,owner_id,starts_at,ends_at,title,status,google_sync_error)
      VALUES($1,$2,$3,'2027-03-01T13:00:00Z','2027-03-01T13:30:00Z',$4,'cancelled','fallo de prueba')`,[tenant,randomUUID(),owner,owner===user?'propia':'del equipo']);
  }
  const keys=await generateKeyPair('ES256');const jwks=createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),alg:'ES256'}]});
  sign=id=>new SignJWT({}).setProtectedHeader({alg:'ES256'}).setSubject(id).setIssuer('https://identity.example.test').setExpirationTime('5m').sign(keys.privateKey);
  app=await createApp({jwtVerify:async token=>({userId:(await jwtVerify(token,jwks,{issuer:'https://identity.example.test'})).payload.sub!}),
    resolveRole:dbRoleResolver(pool),resolveAccesoModulo:null});
  await app.listen(0);base=await app.getUrl();
});
afterAll(async()=>{await app?.close();usarPool(null);await pool?.end();});
async function request(u:string,path:string,init:RequestInit={}){
  return fetch(`${base}/v1/agenda${path}`,{...init,headers:{Authorization:`Bearer ${await sign(u)}`,'X-Tenant-Id':tenant,
    'Content-Type':'application/json','Idempotency-Key':randomUUID(),...init.headers}});
}
describe('calendario propio y disponibilidad del equipo (#57, SPEC §23)',()=>{
  it('USER define, lee y elimina su horario con audit',async()=>{
    const created=await request(user,'/disponibilidad',{method:'POST',body:JSON.stringify({weekday:1,inicio:'09:00',fin:'12:00',duracion:30,respiro:15})});
    expect(created.status).toBe(201);const body=await created.json() as {id:string;ownerId:string};expect(body.ownerId).toBe(user);
    expect((await request(user,'/disponibilidad')).status).toBe(200);
    expect((await request(user,`/disponibilidad/${body.id}`,{method:'DELETE'})).status).toBe(200);
    const entries=await withTenant(pool,tenant,c=>c.query("SELECT action FROM audit_log WHERE tenant_id=$1 AND resource_id=$2 ORDER BY id",[tenant,body.id]));
    expect(entries.rows.map(r=>r.action)).toEqual(['calendar.availability.created','calendar.availability.deleted']);
  });
  it('USER no consulta ni modifica disponibilidad de un compañero',async()=>{
    for(const path of [`/disponibilidad?ownerId=${teammate}`,`/huecos?dia=2027-03-01&ownerId=${teammate}`]){
      const response=await request(user,path);expect(response.status).toBe(403);expect(await response.json()).toMatchObject({code:'PERMISSION_DENIED',requestId:expect.any(String)});
    }
    expect((await request(user,'/disponibilidad',{method:'POST',body:JSON.stringify({ownerId:teammate})})).status).toBe(403);
    expect((await request(user,`/disponibilidad/${randomUUID()}?ownerId=${teammate}`,{method:'DELETE'})).status).toBe(403);
  });
  it('SUPERVISOR gestiona equipo pero no un usuario de otro tenant',async()=>{
    expect((await request(supervisor,'/disponibilidad',{method:'POST',body:JSON.stringify({ownerId:teammate,weekday:2,inicio:'10:00',fin:'11:00'})})).status).toBe(201);
    expect((await request(supervisor,`/disponibilidad?ownerId=${teammate}`)).status).toBe(200);
    expect((await request(supervisor,`/disponibilidad?ownerId=${outsider}`)).status).toBe(404);
  });
  it('la lista y el diagnóstico de Google de USER solo contienen citas propias',async()=>{
    const response=await request(user,'?desde=2027-03-01&hasta=2027-03-02');expect(response.status).toBe(200);
    const rows=await response.json() as Array<{title:string}>;expect(rows.map(r=>r.title)).toEqual(['propia']);
    expect((await request(user,`?desde=2027-03-01&hasta=2027-03-02&ownerId=${teammate}`)).status).toBe(403);
    const cancelled=await request(user,'/cancelaciones?from=2027-03-01&to=2027-03-02');expect(cancelled.status).toBe(200);
    expect((await cancelled.json() as {desincronizadas:unknown[]}).desincronizadas).toHaveLength(1);
    const all=await request(supervisor,'?desde=2027-03-01&hasta=2027-03-02');expect(await all.json()).toHaveLength(2);
  });
  it('dar permiso de horario propio no concede configuración global de recordatorios',async()=>{
    expect((await request(user,'/recordatorios',{method:'PUT',body:'{}'})).status).toBe(403);
    expect((await request(supervisor,'/recordatorios',{method:'PUT',body:'{}'})).status).toBe(403);
  });
});
