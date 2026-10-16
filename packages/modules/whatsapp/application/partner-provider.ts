import { createGoogleSecretStore, type GoogleSecretStore } from '@iaxti/google';
import { esNombreDeVariable, textoDeEntorno } from '@iaxti/core';
import { isChannelSecretRef } from '@iaxti/module-channels';
import { ZAVU_API_BASE_DEFAULT } from './zavu';

export class PartnerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
}
export interface PartnerConfig { projectId: string; credentialRef: string; publicApiUrl: string; projectWebhookSecret: string }
export interface PartnerPorts {
  config: PartnerConfig;
  call: (path: string, method?: string, body?: unknown) => Promise<Record<string, unknown>>;
  secrets: GoogleSecretStore;
  enabled: () => boolean;
}
export function partnerSecretStore(): GoogleSecretStore {
  return createGoogleSecretStore({projectId: process.env.GOOGLE_SECRET_PROJECT_ID ?? '', location: process.env.GOOGLE_SECRET_LOCATION ?? ''});
}
export function partnerPorts(enabled: () => boolean): PartnerPorts {
  const credentialRef = process.env.ZAVU_PARTNER_CREDENTIAL_REF?.trim() || 'ZAVU_API_KEY';
  const projectId = process.env.ZAVU_PARTNER_PROJECT_ID?.trim() ?? '';
  const publicApiUrl = process.env.ZAVU_PARTNER_API_URL?.trim() ?? '';
  const projectWebhookSecret = process.env.ZAVU_PARTNER_WEBHOOK_SECRET ?? '';
  if (!esNombreDeVariable(credentialRef) || !process.env[credentialRef]?.trim() || !projectId || !projectWebhookSecret || !/^https:\/\/[^\s?#]+$/.test(publicApiUrl)) {
    throw new PartnerError('PARTNER_NOT_CONFIGURED','La conexión de WhatsApp aún no está disponible. Intenta más tarde.',503);
  }
  const url = new URL(publicApiUrl);
  if (url.username || url.password) throw new PartnerError('PARTNER_NOT_CONFIGURED','La conexión de WhatsApp aún no está disponible. Intenta más tarde.',503);
  const base = textoDeEntorno('ZAVU_API_BASE',ZAVU_API_BASE_DEFAULT).replace(/\/$/,'');
  return {config:{projectId,credentialRef,publicApiUrl,projectWebhookSecret},enabled,secrets:partnerSecretStore(),
    async call(path,method='GET',body) {
      try {
        const response = await fetch(`${base}${path}`,{method,signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${process.env[credentialRef]}`,...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
        if (!response.ok) throw new PartnerError('PARTNER_PROVIDER_FAILED','Zavu no pudo completar este paso. Revisa el estado antes de reintentar.',502);
        const reader=response.body?.getReader(); let size=0; const chunks:Uint8Array[]=[];
        if (!reader) throw new Error('empty');
        try { for (;;) { const part=await reader.read(); if(part.done)break; size+=part.value.length; if(size>65536) {await reader.cancel(); throw new Error('size');} chunks.push(part.value); } } finally {reader.releaseLock();}
        const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('shape');
        return value as Record<string,unknown>;
      } catch { throw new PartnerError('PARTNER_PROVIDER_FAILED','Zavu no pudo completar este paso. Revisa el estado antes de reintentar.',502); }
    }};
}
export async function resolveChannelWebhookSecret(account:{tenantId:string;id:string;webhookSecretRef:string|null}, store?:GoogleSecretStore, signal?:AbortSignal):Promise<string|undefined> {
  const ref=account.webhookSecretRef;
  if (!ref)return undefined;
  if (esNombreDeVariable(ref))return process.env[ref];
  if (!isChannelSecretRef(ref,account.tenantId,account.id))return undefined;
  return (store ?? partnerSecretStore()).access(ref.slice(3),{signal});
}
export interface PartnerInvitation { id:string; url:string; status:string; expiresAt:string; senderId:string|null; phoneNumberId:string|null; wabaId:string|null }
export function invitationFrom(value:unknown, expected?:string):PartnerInvitation {
  const r=(value as {invitation?:Record<string,unknown>}|null)?.invitation;
  if(!r || typeof r.id!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(r.id) || (expected && expected!==r.id)
    || r.connectionType!=='whatsapp_waba' || !['pending','in_progress','completed','failed','expired','cancelled'].includes(String(r.status))
    || typeof r.url!=='string' || !Number.isFinite(Date.parse(String(r.expiresAt)))) throw new PartnerError('PARTNER_RESPONSE_INVALID','Zavu devolvió una conexión que no pudimos comprobar.',502);
  const u=new URL(r.url);
  if(u.origin!=='https://dashboard.zavu.dev' || !/^\/invite\/[A-Za-z0-9_-]+$/.test(u.pathname) || u.search || u.hash || u.username || u.password) throw new PartnerError('PARTNER_RESPONSE_INVALID','Zavu devolvió un enlace que no pudimos comprobar.',502);
  const connected=r.connectedAccount as {channel?:unknown;id?:unknown}|null;
  if(r.status==='completed' && (typeof r.senderId!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(r.senderId) || connected?.channel!=='whatsapp' || typeof connected.id!=='string')) throw new PartnerError('PARTNER_RESPONSE_INVALID','Zavu no confirmó el número conectado.',502);
  return {id:r.id,url:r.url,status:String(r.status),expiresAt:String(r.expiresAt),senderId:typeof r.senderId==='string'?r.senderId:null,
    phoneNumberId:typeof connected?.id==='string'?connected.id:null,wabaId:null};
}
