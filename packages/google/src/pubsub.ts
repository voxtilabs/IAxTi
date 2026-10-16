import { OAuth2Client } from 'google-auth-library';
import { createTransport, GoogleIntegrationError, record, type GoogleTransportOptions, type GoogleRequestOptions } from './http';
export interface GooglePubSubConfig { audience:string; serviceAccountEmail:string }
export interface GooglePubSubVerifier { verify(token:string,options?:GoogleRequestOptions):Promise<void> }
type Certificates = {certs:Record<string,string>;until:number;fetchedAt:number};
type CertificateState = {cached?:Certificates;pending?:Promise<Certificates>;lastAttempt:number};
// Las claves públicas pertenecen al endpoint fijo de Google, no al audience.
// Compartir por transporte mantiene aisladas las pruebas y sobrevive a factories
// que construyen un verificador por request. Los claims se verifican por instancia.
const certificates = new WeakMap<typeof globalThis.fetch,CertificateState>();
/** Autenticación OIDC del transporte Pub/Sub; no es el ID token del usuario. */
export function createGooglePubSubVerifier(config:GooglePubSubConfig,options:GoogleTransportOptions={}):GooglePubSubVerifier {
  let audience:URL;try{audience=new URL(config.audience);}catch{throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');}
  if(audience.protocol!=='https:'||audience.username||audience.password||audience.hash||! /^[a-zA-Z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.serviceAccountEmail))throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
  const client=new OAuth2Client();const send=options.fetch??globalThis.fetch;
  // La verificación no deja un fetch de 10s vivo después del límite HTTP de800ms.
  const request=createTransport({...options,fetch:send,timeoutMs:Math.min(options.timeoutMs??10000,650)});
  let state=certificates.get(send);if(!state){state={lastAttempt:0};certificates.set(send,state);}
  const shared=state;
  return{async verify(token,opt={}){
    try{
      opt.signal?.throwIfAborted();
      if(typeof token!=='string'||token.length>16384)throw new Error();
      const header=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString('utf8')) as {alg?:string;kid?:string};
      if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||header.kid.length>128)throw new Error();
      let cached=shared.cached;
      if(!cached||cached.until<=Date.now()||!Object.hasOwn(cached.certs,header.kid)){
        if(!shared.pending){
          // Kid desconocido: un refresco por minuto; red caída: uno por segundo.
          if(cached&&!Object.hasOwn(cached.certs,header.kid)&&Date.now()-shared.lastAttempt<60000)throw new Error();
          if(Date.now()-shared.lastAttempt<1000)throw new Error();
          shared.lastAttempt=Date.now();
          shared.pending=(async()=>{
            const body=record(await request('https://www.googleapis.com/oauth2/v1/certs',{method:'GET'}));
            const entries=Object.entries(body);if(!entries.length||entries.length>32)throw new Error();
            const certs:Record<string,string>=Object.create(null);
            for(const[key,value]of entries){if(typeof value!=='string'||value.length>50000)throw new Error();certs[key]=value;}
            const next={certs,until:Date.now()+300000,fetchedAt:Date.now()};shared.cached=next;return next;
          })().finally(()=>{shared.pending=undefined;});
        }
        // El fetch compartido tiene su propio techo650ms. Cancelar una entrega
        // no aborta las demás que están comprobando el mismo juego de claves.
        cached=await shared.pending;
      }
      opt.signal?.throwIfAborted();
      const ticket=await client.verifySignedJwtWithCertsAsync(token,cached.certs,config.audience,['accounts.google.com','https://accounts.google.com']);
      opt.signal?.throwIfAborted();
      const p=ticket.getPayload();const now=Math.floor(Date.now()/1000);
      if(!p||p.email!==config.serviceAccountEmail||p.email_verified!==true||!p.sub||!p.exp||p.exp<=now||!p.iat||p.iat>now+60||p.exp-p.iat>3600)throw new Error();
    }catch{throw new GoogleIntegrationError('GOOGLE_ID_TOKEN_INVALID');}
  }};
}
