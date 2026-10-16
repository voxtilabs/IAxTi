import { OAuth2Client } from 'google-auth-library';
import { createTransport, GoogleIntegrationError, record, type GoogleTransportOptions, type GoogleRequestOptions } from './http';
export interface GooglePubSubConfig { audience:string; serviceAccountEmail:string }
export interface GooglePubSubVerifier { verify(token:string,options?:GoogleRequestOptions):Promise<void> }
/** Autenticación OIDC del transporte Pub/Sub; no es el ID token del usuario. */
export function createGooglePubSubVerifier(config:GooglePubSubConfig,options:GoogleTransportOptions={}):GooglePubSubVerifier {
  let audience:URL;try{audience=new URL(config.audience);}catch{throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');}
  if(audience.protocol!=='https:'||audience.username||audience.password||audience.hash||! /^[a-zA-Z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.serviceAccountEmail))throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
  const client=new OAuth2Client();const request=createTransport(options);
  let cached:{certs:Record<string,string>;until:number;fetchedAt:number}|undefined;
  return{async verify(token,opt={}){
    try{
      if(typeof token!=='string'||token.length>16384)throw new Error();
      const header=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString('utf8')) as {alg?:string;kid?:string};
      if(header.alg!=='RS256'||!header.kid)throw new Error();
      if(!cached||cached.until<=Date.now()||!cached.certs[header.kid]){
        // Un kid inventado no provoca un fetch por petición. La rotación de
        // claves puede reintentarse al minuto, sin aceptar nunca la firma desconocida.
        if(cached&&!cached.certs[header.kid]&&Date.now()-cached.fetchedAt<60000)throw new Error();
        const body=record(await request('https://www.googleapis.com/oauth2/v1/certs',{method:'GET'},opt));
        const certs:Record<string,string>={};
        for(const [key,value] of Object.entries(body)){if(typeof value!=='string'||value.length>50000)throw new Error();certs[key]=value;}
        cached={certs,until:Date.now()+300000,fetchedAt:Date.now()};
      }
      const ticket=await client.verifySignedJwtWithCertsAsync(token,cached.certs,config.audience,['accounts.google.com','https://accounts.google.com']);
      const p=ticket.getPayload();const now=Math.floor(Date.now()/1000);
      if(!p||p.email!==config.serviceAccountEmail||p.email_verified!==true||!p.sub||!p.exp||p.exp<=now||!p.iat||p.iat>now+60||p.exp-p.iat>3600)throw new Error();
    }catch{throw new GoogleIntegrationError('GOOGLE_ID_TOKEN_INVALID');}
  }};
}
