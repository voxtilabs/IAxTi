import {generateKeyPairSync,sign} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {gmailDesdeEntorno} from '../application/gmail-config';
const{privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const env={GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-client-secret',GOOGLE_GMAIL_REDIRECT_URI:'https://app.example.test/integraciones/gmail/callback',GOOGLE_SECRET_PROJECT_ID:'test-project',GOOGLE_SECRET_LOCATION:'southamerica-west1',GOOGLE_GMAIL_TOPIC:'projects/test-project/topics/gmail',GOOGLE_GMAIL_SUBSCRIPTION:'projects/test-project/subscriptions/gmail',GOOGLE_GMAIL_PUSH_AUDIENCE:'https://api.example.test/webhooks/google/gmail',GOOGLE_GMAIL_PUSH_SERVICE_ACCOUNT:'gmail@test-project.iam.gserviceaccount.com'};
function token(aud=env.GOOGLE_GMAIL_PUSH_AUDIENCE,kid='key'){const now=Math.floor(Date.now()/1000);const h=Buffer.from(JSON.stringify({alg:'RS256',kid})).toString('base64url');const b=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud,email:env.GOOGLE_GMAIL_PUSH_SERVICE_ACCOUNT,email_verified:true,sub:'123',iat:now-1,exp:now+3599})).toString('base64url');return`${h}.${b}.${sign('RSA-SHA256',Buffer.from(`${h}.${b}`),privateKey).toString('base64url')}`;}
afterEach(()=>vi.unstubAllGlobals());
it('factories por request reutilizan certificados y límite de kid, conservan audience por configuración',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify({key:publicKey.export({type:'spki',format:'pem'})}),{status:200}));vi.stubGlobal('fetch',fetch);
  const one=gmailDesdeEntorno(env)!;const two=gmailDesdeEntorno(env)!;
  await Promise.all([one.pubsub.verify(token()),two.pubsub.verify(token())]);expect(fetch).toHaveBeenCalledTimes(1);
  await expect(gmailDesdeEntorno(env)!.pubsub.verify(token(undefined,'unknown'))).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  const another=gmailDesdeEntorno({...env,GOOGLE_GMAIL_PUSH_AUDIENCE:'https://other.example.test/push'})!;
  await expect(another.pubsub.verify(token())).rejects.toThrow();await another.pubsub.verify(token('https://other.example.test/push'));expect(fetch).toHaveBeenCalledTimes(1);
});
