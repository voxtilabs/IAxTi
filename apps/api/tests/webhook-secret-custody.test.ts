import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import type {INestApplication} from '@nestjs/common';
const f=vi.hoisted(()=>({resolve:vi.fn(),verify:vi.fn(),normalize:vi.fn(),add:vi.fn(),state:'active'}));
vi.mock('../src/db',()=>({apiPool:()=>({})}));
vi.mock('@iaxti/db',async original=>({...await original<object>(),withTenant:async(_p:unknown,_t:unknown,fn:(c:object)=>unknown)=>fn({})}));
vi.mock('@iaxti/module-whatsapp',async original=>({...await original<object>(),resolveChannelWebhookSecret:f.resolve}));
vi.mock('@iaxti/module-channels',async original=>({...await original<object>(),tenantDeCuenta:async()=> 'tenant',findAccountById:async()=>({id:'account',tenantId:'tenant',kind:'whatsapp',state:f.state,webhookSecretRef:'sm:synthetic'}),getProvider:()=>({verifyWebhook:f.verify,normalize:f.normalize})}));
vi.mock('@iaxti/core',async original=>({...await original<object>(),createQueue:()=>({add:f.add})}));
import {createApp} from '../src/main';
let app:INestApplication,base:string;
beforeAll(async()=>{vi.stubEnv('DATABASE_URL','');app=await createApp({jwtVerify:null,resolveRole:null});await app.listen(0);base=await app.getUrl();});
afterAll(async()=>{await app.close();vi.unstubAllEnvs();});
it('SM detenido respeta presupuesto de webhook: aborta, 503 Retry-After, cero verificación/normalización/cola',async()=>{
 let signal:AbortSignal|undefined;f.resolve.mockImplementation((_a,_s,value)=>{signal=value;return new Promise(()=>{});});
 const began=performance.now();const r=await fetch(`${base}/webhooks/channels/account`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBe('5');expect(performance.now()-began).toBeLessThan(1000);expect(signal?.aborted).toBe(true);
 expect(f.verify).not.toHaveBeenCalled();expect(f.normalize).not.toHaveBeenCalled();expect(f.add).not.toHaveBeenCalled();
});
it('entrega entre enable remoto y commit active local pide reentrega sin falso 401 ni ACK',async()=>{
 vi.clearAllMocks();f.state='connecting';
 try{const r=await fetch(`${base}/webhooks/channels/account`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBe('5');expect((await r.json()).code).toBe('WEBHOOK_NOT_READY');
 expect(f.resolve).not.toHaveBeenCalled();expect(f.verify).not.toHaveBeenCalled();expect(f.add).not.toHaveBeenCalled();}finally{f.state='active';}
});
