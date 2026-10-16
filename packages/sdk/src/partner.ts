import { partnerRoutes } from './partner-routes.generated';
import { RegistrationError } from './registration';
export interface PartnerInvitationState {id:string|null;phase:string;providerStatus:string|null;url:string|null;expiresAt:string|null;accountId:string|null;errorCode:string|null}
export function partnerClient(config:{apiUrl:string;token:string;tenantId:string}) {
  async function call<T>(operation:keyof typeof partnerRoutes,signal:AbortSignal,body?:unknown,key?:string):Promise<T> {
    const route=partnerRoutes[operation];
    const response=await fetch(`${config.apiUrl.replace(/\/$/,'')}${route.path}`,{method:route.method,signal,cache:'no-store',referrerPolicy:'no-referrer',headers:{Authorization:`Bearer ${config.token}`,'X-Tenant-Id':config.tenantId,...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>null);
    if(!response.ok || !data)throw new RegistrationError(data?.code??'PARTNER_UNAVAILABLE',data?.message??'No pudimos consultar la conexión. Intenta de nuevo.',response.status,data?.requestId??'');
    return data as T;
  }
  return {status:(signal:AbortSignal)=>call<PartnerInvitationState>('PartnerInvitationsController_status',signal),
    start:(key:string,signal:AbortSignal)=>call<PartnerInvitationState>('PartnerInvitationsController_start',signal,{},key),
    resume:(id:string,signal:AbortSignal)=>call<{queued:boolean}>('PartnerInvitationsController_resume',signal,{id})};
}
