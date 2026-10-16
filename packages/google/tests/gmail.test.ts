import {generateKeyPairSync,sign} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {createGoogleGmailClient,createGooglePubSubVerifier,gmailContactEmail} from '../src';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const message=(address:string,stamp='1700000000000',snippet='Extracto',subject='Asunto')=>({id:'m1',snippet,internalDate:stamp,payload:{headers:[{name:'From',value:address},{name:'Subject',value:subject}]}});
const response=(id:string,messages:unknown[])=>({id,messages});
describe('Gmail: puerto HTTP de lectura acotado',()=>{
  it('consulta candidatos, comprueba direcciones exactas y ordena el último mensaje coincidente',async()=>{
    const send=vi.fn<typeof fetch>().mockImplementation(async(url)=>{
      const u=new URL(String(url));
      if(u.pathname.endsWith('/threads'))return json({threads:[{id:'one'},{id:'two'},{id:'false'}]});
      if(u.pathname.endsWith('/one'))return json(response('one',[message('"Ana, Ventas" <ana@example.com>','1700000000000'),message('other@example.com','1800000000000','Ajeno')]));
      if(u.pathname.endsWith('/two'))return json(response('two',[message('Equipo: ana@example.com (Cliente), b@example.com;','1750000000000','Más reciente')]));
      return json(response('false',[message('"ana@example.com" <juana@example.com>')]));
    });
    const result=await createGoogleGmailClient({fetch:send}).threads({accessToken:'private-token',email:'Ana@example.com'});
    expect(result.threads.map(t=>t.id)).toEqual(['two','one']);expect(result.threads[1].snippet).toBe('Extracto');expect(result.truncated).toBe(false);
    const list=new URL(String(send.mock.calls[0][0]));expect(list.searchParams.get('q')).toBe('{from:"ana@example.com" to:"ana@example.com" cc:"ana@example.com" bcc:"ana@example.com"}');
    for(const [url,init]of send.mock.calls){expect(new URL(String(url)).origin).toBe('https://gmail.googleapis.com');expect(init?.method).toBe('GET');expect(init?.redirect).toBe('error');expect(String(url)).not.toContain('private-token');}
    const get=new URL(String(send.mock.calls[1][0]));expect(get.searchParams.get('fields')).toBe('id,messages(id,snippet,internalDate,payload(headers(name,value)))');expect(get.searchParams.get('fields')).not.toMatch(/body|parts|raw|attachments/);
  });
  it.each(['ana@example.com OR newer:1d','a\r\n@example.com','a@example.com"','a@example.com/../','a@localhost'])('rechaza correo no representable %s',async email=>{
    const send=vi.fn<typeof fetch>();await expect(createGoogleGmailClient({fetch:send}).threads({accessToken:'t',email})).rejects.toMatchObject({code:'GOOGLE_INPUT_INVALID'});expect(send).not.toHaveBeenCalled();
  });
  it('el local part con operadores permanece citado y solo coincide de forma exacta',()=>{expect(gmailContactEmail('a{b}@example.com')).toBe('a{b}@example.com');});
  it('pagina, deduplica y declara el límite sin convertirlo en lista completa',async()=>{
    const send=vi.fn<typeof fetch>().mockImplementation(async url=>{
      const u=new URL(String(url));if(u.pathname.endsWith('/threads'))return json({threads:[{id:'one'}],nextPageToken:'next'});
      return json(response('one',[message('ana@example.com')]));
    });
    const result=await createGoogleGmailClient({fetch:send}).threads({accessToken:'t',email:'ana@example.com'});
    expect(result.truncated).toBe(true);expect(result.threads).toHaveLength(1);expect(send).toHaveBeenCalledTimes(4);
  });
  it('un fallo de página posterior nunca devuelve resultados parciales como éxito',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(json({threads:[{id:'one'}],nextPageToken:'p2'})).mockResolvedValueOnce(json({error:'private-body'},500));
    await expect(createGoogleGmailClient({fetch:send}).threads({accessToken:'t',email:'ana@example.com'})).rejects.toMatchObject({code:'GOOGLE_REQUEST_FAILED'});
  });
  it.each([response('a',[]),response('a',[message('ana@example.com','nan')]),response('a',[{...message('ana@example.com'),snippet:undefined}]),{}])('respuesta incompleta falla cerrada %#',async bad=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(json({threads:[{id:'a'}]})).mockResolvedValueOnce(json(bad));
    await expect(createGoogleGmailClient({fetch:send}).threads({accessToken:'t',email:'ana@example.com'})).rejects.toMatchObject({code:'GOOGLE_RESPONSE_INVALID'});
  });
  it('profile acredita buzón, watch sin filtro INBOX conserva historia grande, stop no modifica correos',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(json({emailAddress:'me@example.com',historyId:'9007199254740993123'})).mockResolvedValueOnce(json({historyId:'9007199254740993124',expiration:'1900000000000'})).mockResolvedValueOnce(new Response(null,{status:204}));
    const client=createGoogleGmailClient({fetch:send});expect(await client.profile('t')).toMatchObject({emailAddress:'me@example.com',historyId:'9007199254740993123'});
    expect(await client.watch({accessToken:'t',topicName:'projects/test-project/topics/gmail-push'})).toMatchObject({historyId:'9007199254740993124'});
    expect(JSON.parse(String(send.mock.calls[1][1]?.body))).toEqual({topicName:'projects/test-project/topics/gmail-push'});await client.stop('t');expect(String(send.mock.calls[2][0])).toMatch(/users\/me\/stop$/);
  });
});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const cfg={audience:'https://app.example.test/v1/webhooks/google/gmail',serviceAccountEmail:'gmail-push@test-project.iam.gserviceaccount.com'};
function jwt(overrides:Record<string,unknown>={},bad=false){const now=Math.floor(Date.now()/1000);const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url');const payload=Buffer.from(JSON.stringify({aud:cfg.audience,iss:'https://accounts.google.com',sub:'123456789',email:cfg.serviceAccountEmail,email_verified:true,iat:now-1,exp:now+3599,...overrides})).toString('base64url');const data=`${header}.${payload}`;return `${data}.${bad?'invalid':sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url')}`;}
describe('Pub/Sub OIDC con firmas RSA reales',()=>{
  const send=()=>vi.fn<typeof fetch>().mockResolvedValue(json({'test-key':publicKey.export({type:'spki',format:'pem'})}));
  it('valida firma y identidad de servicio, cachea certificados por tiempo acotado',async()=>{const fetch=send();const v=createGooglePubSubVerifier(cfg,{fetch});await v.verify(jwt());await v.verify(jwt());expect(fetch).toHaveBeenCalledTimes(1);});
  it.each([{aud:'https://otro.test'},{iss:'https://evil.test'},{email:'other@test-project.iam.gserviceaccount.com'},{email_verified:false},{exp:1},{iat:Math.floor(Date.now()/1000)+1000},{exp:Math.floor(Date.now()/1000)+8000}])('rechaza claims incompatibles %#',async claims=>{await expect(createGooglePubSubVerifier(cfg,{fetch:send()}).verify(jwt(claims))).rejects.toMatchObject({code:'GOOGLE_ID_TOKEN_INVALID'});});
  it('kid desconocido no fuerza fetch repetido dentro del minuto',async()=>{const fetch=send();const verifier=createGooglePubSubVerifier(cfg,{fetch});await verifier.verify(jwt());const original=jwt().split('.');original[0]=Buffer.from(JSON.stringify({alg:'RS256',kid:'unknown'})).toString('base64url');for(let i=0;i<3;i++)await expect(verifier.verify(original.join('.'))).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);});
  it('dos instancias comparten caché/singleflight sin compartir audiences ni service accounts',async()=>{
    const fetch=send();const one=createGooglePubSubVerifier(cfg,{fetch});const two=createGooglePubSubVerifier({...cfg,audience:'https://other.example.test/push'},{fetch});
    await Promise.all([one.verify(jwt()),two.verify(jwt({aud:'https://other.example.test/push'}))]);expect(fetch).toHaveBeenCalledTimes(1);
    await expect(two.verify(jwt())).rejects.toThrow();await expect(createGooglePubSubVerifier({...cfg,serviceAccountEmail:'wrong@test-project.iam.gserviceaccount.com'},{fetch}).verify(jwt())).rejects.toThrow();
    const unknown=jwt().split('.');unknown[0]=Buffer.from(JSON.stringify({alg:'RS256',kid:'new-kid'})).toString('base64url');
    await expect(createGooglePubSubVerifier(cfg,{fetch}).verify(unknown.join('.'))).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('la rotación legítima obtiene la nueva clave pasado el límite de refresco',async()=>{
    const certificate=publicKey.export({type:'spki',format:'pem'});const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({'test-key':certificate})).mockResolvedValueOnce(json({'rotated-key':certificate}));
    const v=createGooglePubSubVerifier(cfg,{fetch});await v.verify(jwt());
    const parts=jwt().split('.');parts[0]=Buffer.from(JSON.stringify({alg:'RS256',kid:'rotated-key'})).toString('base64url');parts[2]=sign('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),privateKey).toString('base64url');
    await expect(v.verify(parts.join('.'))).rejects.toThrow();const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+61000);
    try{await createGooglePubSubVerifier(cfg,{fetch}).verify(parts.join('.'));expect(fetch).toHaveBeenCalledTimes(2);}finally{clock.mockRestore();}
  });
  it('certificados lentos se abortan antes del deadline webhook y no quedan fetchs por cada instancia',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>((_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('PRIVATE-NETWORK-BODY')),{once:true})));
    const start=Date.now();const checks=Array.from({length:4},()=>createGooglePubSubVerifier(cfg,{fetch}).verify(jwt()));
    const results=await Promise.allSettled(checks);expect(results.every(r=>r.status==='rejected')).toBe(true);expect(Date.now()-start).toBeLessThan(800);expect(fetch).toHaveBeenCalledTimes(1);expect(JSON.stringify(results)).not.toContain('PRIVATE-NETWORK-BODY');
  });
  it('rechaza firma y no expone token en el fallo',async()=>{const token=jwt({},true);const error=await createGooglePubSubVerifier(cfg,{fetch:send()}).verify(token).catch(e=>e);expect(error.code).toBe('GOOGLE_ID_TOKEN_INVALID');expect(String(error)+JSON.stringify(error)).not.toContain(token);});
});
