import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createPool,runMigrations,withTenant} from '@iaxti/db';
import {CATALOGO,herramientasPara} from '../application/catalogo';
import {aplicarPropuesta,conversarConElAgenteGeneral} from '../application/agente-general';
import type {ModelPort} from '../application/models';
const pool=createPool(process.env.DATABASE_URL);let tenantId:string;
const permissions=new Set(['integrations.read','integrations.connect']);const modules=new Set(['integrations']);
beforeAll(async()=>{await runMigrations(pool);tenantId=(await pool.query("INSERT INTO tenants(name) VALUES('drive-tool') RETURNING id")).rows[0].id;});
afterAll(async()=>{await pool.end();});
it('catálogo ofrece exactamente drive.search/attach; consentimiento/selector nunca son tools',()=>{
  const tools=CATALOGO.filter(tool=>tool.nombre.startsWith('drive.'));expect(tools.map(tool=>tool.nombre)).toEqual(['drive.attach','drive.search']);
  expect(tools.find(tool=>tool.nombre==='drive.attach')).toMatchObject({trato:'confirmar',permiso:'integrations.connect',modulo:'integrations'});
  expect(tools.find(tool=>tool.nombre==='drive.search')).toMatchObject({trato:'libre',permiso:'integrations.read'});
  expect((tools[0].argumentos.properties as Record<string,unknown>).context).toBeTruthy();
  expect(herramientasPara({permisos:new Set(),modulosActivos:modules}).some(tool=>tool.nombre.startsWith('drive.'))).toBe(false);
  expect(herramientasPara({permisos:permissions,modulosActivos:new Set()}).some(tool=>tool.nombre.startsWith('drive.'))).toBe(false);
});
it('attach nunca ejecuta hasta que la persona confirme y revalida permisos al aplicar',async()=>{
  const args={id:randomUUID(),context:{contactId:randomUUID()}};const call=vi.fn(async()=>({ok:true,estado:200,datos:{attached:true}}));
  const model:ModelPort={generate:async input=>{await input.tools!.find(tool=>tool.name==='preparar_accion')!.ejecutar({herramienta:'drive.attach',argumentos:args});return {text:'La referencia está pendiente de tu confirmación.',tokensIn:1,tokensOut:1};}};
  const result=await withTenant(pool,tenantId,c=>conversarConElAgenteGeneral(c,{tenantId,actorUserId:randomUUID(),turnos:[{role:'user',content:'Adjunta este archivo'}],permisos:permissions,modulosActivos:modules},{provider:'glm',model:'z-ai/glm-5.3',modelo:model,llamarApi:call}));
  expect(call).not.toHaveBeenCalled();expect(result.propuesta).toMatchObject({herramienta:'drive.attach',argumentos:args});
  await expect(aplicarPropuesta({herramienta:'drive.attach',argumentos:args,permisos:new Set(),modulosActivos:modules},{llamarApi:call})).rejects.toThrow('No tienes permiso');expect(call).not.toHaveBeenCalled();
  await aplicarPropuesta({herramienta:'drive.attach',argumentos:args,permisos:permissions,modulosActivos:modules},{llamarApi:call});
  expect(call).toHaveBeenCalledWith({metodo:'POST',ruta:'/v1/integraciones/drive/adjuntar',query:{},cuerpo:args});
});
