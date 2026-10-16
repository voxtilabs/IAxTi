import {gmailRoutes} from './gmail-routes.generated';
export interface GmailState {configured:boolean;status:'disconnected'|'active'|'reauth_required'|'revoking'|'revoked';pushActive:boolean;lastNotificationAt:string|null}
export interface GmailThreadSummary {id:string;subject:string;snippet:string;lastMessageAt:string}
export interface GmailThreadResult {state:'ready'|'no_email';threads:GmailThreadSummary[];truncated:boolean;fetchedAt:string|null;cached:boolean;pushActive:boolean}
export class GmailSdkError extends Error {constructor(public readonly code:string,message:string,public readonly status:number,public readonly requestId:string){super(message);}}
export function gmailClient(config:{apiUrl:string;token:string;tenantId:string}){
  async function call<T>(operation:keyof typeof gmailRoutes,options:{body?:unknown;key?:string;query?:URLSearchParams;signal?:AbortSignal}={}):Promise<T>{
    const route=gmailRoutes[operation];const response=await fetch(`${config.apiUrl.replace(/\/$/,'')}${route.path}${options.query?`?${options.query}`:''}`,{
      method:route.method,cache:'no-store',referrerPolicy:'no-referrer',signal:options.signal,
      headers:{Authorization:`Bearer ${config.token}`,'X-Tenant-Id':config.tenantId,...options.body===undefined?{}:{'Content-Type':'application/json'},...options.key?{'Idempotency-Key':options.key}:{}},
      ...options.body===undefined?{}:{body:JSON.stringify(options.body)}});
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result)throw new GmailSdkError(result?.code??'GMAIL_FAILED',result?.message??'No pudimos consultar Gmail. Intenta otra vez.',response.status,result?.requestId??'');
    return result as T;
  }
  return{state:(signal?:AbortSignal)=>call<GmailState>('GmailController_estado',{signal}),start:(challenge:string)=>call<{state:string;nonce:string;url:string}>('GmailController_iniciar',{body:{challenge}}),
    finish:(body:{state:string;nonce:string;verifier:string;code:string},key:string)=>call<GmailState>('GmailController_completar',{body,key}),
    revoke:(key:string)=>call<{revoked:true}>('GmailController_revocar',{key}),
    threads:(contactId:string,refresh=false,signal?:AbortSignal)=>call<GmailThreadResult>('GmailController_get_threads',{query:new URLSearchParams({contactId,refresh:String(refresh)}),signal})};
}
