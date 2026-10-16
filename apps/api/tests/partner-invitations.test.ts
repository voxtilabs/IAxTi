import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import type {INestApplication,ExecutionContext} from '@nestjs/common';
import type {Pool} from 'pg';
import {firstValueFrom,of} from 'rxjs';
const service=vi.hoisted(()=>({status:vi.fn(),start:vi.fn(),resume:vi.fn(),receive:vi.fn()}));
vi.mock('@iaxti/module-whatsapp',async original=>({...await original<object>(),partnerStatus:service.status,startPartnerInvitation:service.start,resumePartnerInvitation:service.resume,receivePartnerWebhook:service.receive}));
import {PartnerError} from '@iaxti/module-whatsapp';
import {createApp} from '../src/main';
import {registry} from '../src/registry';
import {PARTNER_HTTP,PartnerInvitationsController,type partnerHttp} from '../src/partner-invitations.controller';
import {IdempotenciaInterceptor} from '../src/idempotencia.interceptor';
import {partnerRoutes} from '../../../packages/sdk/src/partner-routes.generated';
let app:INestApplication,base:string,deps:typeof partnerHttp,old:typeof partnerHttp;
const enqueue=vi.fn(async()=>{});
const headers={Authorization:'Bearer human','X-Tenant-Id':'tenant-a','Content-Type':'application/json','Idempotency-Key':'local-attempt'};
beforeAll(async()=>{
 app=await createApp({jwtVerify:async token=>{if(token!=='human')throw new Error();return {userId:'verified'};},resolveRole:async t=>t==='tenant-a'?'ADMIN':t==='tenant-denied'?'USER':null,resolveAccesoModulo:null,resolvePlatformAdmin:null});
 deps=app.get(PARTNER_HTTP);old={...deps};deps.pool=()=>({} as Pool);deps.ports=()=>({} as ReturnType<typeof deps.ports>);deps.enqueue=enqueue;
 await app.listen(0);base=await app.getUrl();
});
afterEach(()=>{vi.clearAllMocks();registry.enable('whatsapp');});
afterAll(async()=>{Object.assign(deps,old);await app.close();});
const post=(path:string,body:unknown={},extra:Record<string,string>={})=>fetch(`${base}${path}`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
it('JWT+tenant+permiso: no headers alternativos, otra membresía, USER ni API key',async()=>{
 for(const [extra,status]of [[{Authorization:'','X-User-Id':'pretend','X-Role':'ADMIN'},401],[{Authorization:'Bearer bad'},401],[{'X-Tenant-Id':'other'},403],[{'X-Tenant-Id':'tenant-denied'},403],[{Authorization:'','X-Api-Key':'key'},401]] as Array<[Record<string,string>,number]>){const r=await post('/v1/onboarding/whatsapp',{},extra);expect(r.status).toBe(status);expect(await r.json()).toMatchObject({code:expect.any(String),requestId:expect.any(String),details:expect.any(Array)});}
 expect(service.start).not.toHaveBeenCalled();
});
it('cuerpo cerrado e idempotency-key; sesión verificada, no actor del cuerpo',async()=>{
 service.start.mockResolvedValue({phase:'pending',url:'https://dashboard.zavu.dev/invite/synthetic'});
 expect((await post('/v1/onboarding/whatsapp',{senderId:'global',tenantId:'forged'})).status).toBe(400);
 expect((await post('/v1/onboarding/whatsapp',{}, {'Idempotency-Key':''})).status).toBe(400);
 const r=await post('/v1/onboarding/whatsapp');expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(service.start).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({tenantId:'tenant-a',actor:'verified',actorKind:'user',key:'local-attempt'}),expect.anything());
});
it('modulo off corta antes del proveedor; error inesperado no revela credenciales',async()=>{
 registry.disable('whatsapp');expect((await post('/v1/onboarding/whatsapp')).status).toBe(403);expect(service.start).not.toHaveBeenCalled();registry.enable('whatsapp');
 service.start.mockRejectedValue(new Error('PRIVATE-PROVIDER-TOKEN'));const r=await post('/v1/onboarding/whatsapp');expect(r.status).toBe(503);expect(await r.text()).not.toContain('PRIVATE-PROVIDER');
});
it('callback rawbody sin identidad ficticia encola metadata mínima; cola caída responde error',async()=>{
 service.receive.mockResolvedValue({tenantId:'resolved',invitationId:'local',eventId:'event'});
 const r=await post('/webhooks/zavu/invitations',{private:'DO_NOT_QUEUE'},{Authorization:'','X-Zavu-Signature':'signature'});expect(r.status).toBe(204);
 expect(service.receive).toHaveBeenCalledWith(expect.anything(),'{"private":"DO_NOT_QUEUE"}','signature',expect.anything());expect(enqueue).toHaveBeenCalledWith({tenantId:'resolved',invitationId:'local',eventId:'event'});
 service.receive.mockRejectedValueOnce(new PartnerError('PARTNER_NOT_FOUND','Aún no correlacionada.',503));const early=await post('/webhooks/zavu/invitations',{}, {Authorization:''});expect(early.status).toBe(503);expect(early.headers.get('retry-after')).toBe('5');
 enqueue.mockRejectedValueOnce(new Error('redis'));expect((await post('/webhooks/zavu/invitations',{}, {Authorization:''})).status).toBe(503);
});
it('OpenAPI publica permiso/módulo y rutas exactas; enlace privado no entra en cache idempotente',async()=>{
 const doc=await (await fetch(`${base}/docs-json`)).json();for(const [id,route]of Object.entries(partnerRoutes))expect(doc.paths[route.path][route.method.toLowerCase()]).toMatchObject({operationId:id,'x-iaxti-module':'whatsapp','x-iaxti-permission':'whatsapp.numbers.manage'});
 const connect=vi.fn();const interceptor=new IdempotenciaInterceptor({connect} as unknown as Pool);const ctx={getHandler:()=>PartnerInvitationsController.prototype.start} as unknown as ExecutionContext;
 expect(await firstValueFrom(interceptor.intercept(ctx,{handle:()=>of({url:'sensitive'})}))).toEqual({url:'sensitive'});expect(connect).not.toHaveBeenCalled();
});
it.each(['persistencia','cola'])('callback con %s detenida responde 503 antes de 1s, sin ACK falso',async step=>{
 service.receive.mockResolvedValue({tenantId:'resolved',invitationId:'local',eventId:'event'});
 if(step==='persistencia')service.receive.mockImplementationOnce(()=>new Promise(()=>{}));
 else enqueue.mockImplementationOnce(()=>new Promise(()=>{}));
 const start=performance.now();const r=await post('/webhooks/zavu/invitations',{}, {Authorization:''});
 expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBe('5');expect(performance.now()-start).toBeLessThan(1000);
 if(step==='persistencia')expect(enqueue).not.toHaveBeenCalled();
});
