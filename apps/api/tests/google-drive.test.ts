import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import type {INestApplication,ExecutionContext} from '@nestjs/common';
import type {Pool} from 'pg';
import {firstValueFrom,of} from 'rxjs';
const service=vi.hoisted(()=>({state:vi.fn(),start:vi.fn(),finish:vi.fn(),revoke:vi.fn(),picker:vi.fn(),select:vi.fn(),search:vi.fn(),attach:vi.fn()}));
vi.mock('@iaxti/module-integrations',async original=>({...await original<object>(),estadoDrive:service.state,iniciarDrive:service.start,completarDrive:service.finish,revocarDrive:service.revoke,prepararPickerDrive:service.picker,seleccionarArchivoDrive:service.select,buscarDrive:service.search,adjuntarDrive:service.attach}));
import {createApp} from '../src/main';
import {registry} from '../src/registry';
import {DriveController,GOOGLE_DRIVE_HTTP,googleDriveHttp} from '../src/google-drive.controller';
import {IdempotenciaInterceptor} from '../src/idempotencia.interceptor';
import {driveRoutes} from '../../../scripts/generate-google-drive.mjs';
import {googleDriveRoutes} from '../../../packages/sdk/src/google-drive-routes.generated';
let app:INestApplication;let base:string;let port:typeof googleDriveHttp;let originalPool:typeof googleDriveHttp.pool;let originalDeps:typeof googleDriveHttp.deps;
const headers={Authorization:'Bearer valid-user','X-Tenant-Id':'tenant-a','Content-Type':'application/json'};
const id='11111111-1111-4111-8111-111111111111';const challenge='a'.repeat(43);
beforeAll(async()=>{
  app=await createApp({jwtVerify:async token=>{if(token!=='valid-user')throw new Error();return {userId:'verified-user'};},resolveRole:async tenant=>tenant==='tenant-a'?'USER':tenant==='tenant-no-permission'?'CUSTOM':null,resolveCustomPermissions:async()=>[],resolveAccesoModulo:null,resolvePlatformAdmin:null});
  port=app.get(GOOGLE_DRIVE_HTTP);originalPool=port.pool;originalDeps=port.deps;port.pool=()=>({}as Pool);port.deps=()=>({}as NonNullable<ReturnType<typeof port.deps>>);
  await app.listen(0);base=await app.getUrl();
});
afterEach(()=>{vi.clearAllMocks();registry.enable('integrations');});
afterAll(async()=>{port.pool=originalPool;port.deps=originalDeps;await app.close();});
const post=(path:string,body:unknown,extra:Record<string,string>={})=>fetch(`${base}/v1/integraciones/drive/${path}`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
describe('Drive API, JWT personal y contrato SDK real',()=>{
  it('actor viene de JWT; cuerpo y headers no pueden sustituir usuario/tenant',async()=>{
    service.start.mockResolvedValue({state:challenge,nonce:challenge,url:'https://accounts.google.com/o/oauth2/v2/auth'});
    expect((await post('iniciar',{challenge},{'X-User-Id':'attacker','X-Role':'ADMIN'})).status).toBe(200);
    expect(service.start).toHaveBeenCalledWith(expect.anything(),{tenantId:'tenant-a',userId:'verified-user',challenge},expect.anything());
    expect((await post('iniciar',{challenge,userId:'attacker'})).status).toBe(400);expect(service.start).toHaveBeenCalledTimes(1);
  });
  it('search y attach no aceptan fallback DEV, API key, JWT ajeno ni permisos ausentes',async()=>{
    for(const [extra,status] of [[{Authorization:'','X-User-Id':'fake','X-Role':'ADMIN'},401],[{Authorization:'Bearer iaxti_key','X-Api-Key':'iaxti_key'},401],[{Authorization:'Bearer wrong'},401],[{'X-Tenant-Id':'foreign'},403],[{'X-Tenant-Id':'tenant-no-permission'},403]]as Array<[Record<string,string>,number]>){
      expect((await post('adjuntar',{id,context:{contactId:id}},extra)).status).toBe(status);
      expect((await post('buscar',{query:'texto',context:{contactId:id},readDocuments:true},extra)).status).toBe(status);
    }
    expect(service.attach).not.toHaveBeenCalled();expect(service.search).not.toHaveBeenCalled();
  });
  it('adjuntar requiere contexto, no envía archivos ni cambia identidad',async()=>{
    expect((await post('adjuntar',{id,context:{}})).status).toBe(400);
    service.attach.mockResolvedValue({attached:true,created:true});expect((await post('adjuntar',{id,context:{contactId:id}})).status).toBe(200);
    expect(service.attach).toHaveBeenCalledWith(expect.anything(),{tenantId:'tenant-a',userId:'verified-user',id,context:{contactId:id}},expect.anything());
  });
  it('errores externos no filtran tokens ni respuestas privadas',async()=>{
    service.search.mockRejectedValue(new Error('PRIVATE-TOKEN-DOC'));const response=await post('buscar',{query:''});expect(response.status).toBe(400);expect(await response.text()).not.toContain('PRIVATE');
  });
  it('módulo apagado bloquea lectura y adjuntos',async()=>{
    registry.disable('integrations');expect((await post('buscar',{query:''})).status).toBe(403);expect(service.search).not.toHaveBeenCalled();
  });
  it('OpenAPI conserva cuerpos y produce todas las rutas del SDK',async()=>{
    const doc=await(await fetch(`${base}/docs-json`)).json();expect(driveRoutes(doc)).toEqual(googleDriveRoutes);
    expect(doc.paths['/v1/integraciones/drive/adjuntar'].post).toMatchObject({operationId:'DriveController_attach','x-iaxti-permission':'integrations.connect','x-iaxti-module':'integrations','x-iaxti-auth':'sesion'});
    expect(doc.paths['/v1/integraciones/drive/adjuntar'].post.requestBody.content['application/json'].schema.required).toEqual(['id','context']);
  });
  it('lecturas personales y apertura de consentimiento nunca persisten en caché de idempotencia',async()=>{
    const connect=vi.fn();const interceptor=new IdempotenciaInterceptor({connect}as unknown as Pool);
    for(const handler of [DriveController.prototype.iniciar,DriveController.prototype.selector,DriveController.prototype.search,DriveController.prototype.adjuntos]){
      const context={getHandler:()=>handler}as unknown as ExecutionContext;
      expect(await firstValueFrom(interceptor.intercept(context,{handle:()=>of({private:'personal'})}))).toEqual({private:'personal'});
    }expect(connect).not.toHaveBeenCalled();
  });
});
