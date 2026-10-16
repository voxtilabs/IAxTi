import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {createPool,runMigrations,withTenant} from '@iaxti/db';
import {createContact,getContactMailAccess} from '../application/contacts';
import {suprimirTitular} from '../application/titular';
const pool=createPool(process.env.DATABASE_URL??'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
beforeAll(()=>runMigrations(pool));afterAll(()=>pool.end());
it('puerto de Gmail devuelve dueño/correo actuales y niega un contacto suprimido antes del outbox',async()=>{
  const tenantId=(await pool.query("INSERT INTO tenants(name) VALUES('gmail-contact-port') RETURNING id")).rows[0].id;
  const owner=randomUUID();const contact=await withTenant(pool,tenantId,c=>createContact(c,{tenantId,ownerId:owner,email:'private@example.test',name:'Prueba',phone:'+56978889990'}));
  expect(await withTenant(pool,tenantId,c=>getContactMailAccess(c,tenantId,contact.id))).toEqual({email:'private@example.test',ownerId:owner});
  await withTenant(pool,tenantId,c=>suprimirTitular(c,{tenantId,contactId:contact.id,actor:owner,motivo:"Ensayo de supresión",almacen:{borrar:async keys=>({borradas:keys,fallidas:[]})}}));
  expect(await withTenant(pool,tenantId,c=>getContactMailAccess(c,tenantId,contact.id))).toBeNull();
  expect((await pool.query("SELECT processed_at FROM outbox WHERE tenant_id=$1 AND name='contact.anonymized'",[tenantId])).rows[0]).toEqual({processed_at:null});
});
