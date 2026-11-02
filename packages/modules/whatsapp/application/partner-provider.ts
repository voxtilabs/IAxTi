import { createGoogleSecretStore, type GoogleSecretStore, custodiaDesdeEntorno} from '@iaxti/google';
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
/**
 * Dónde se guarda el secreto del webhook (#1175).
 *
 * Acá decía `createGoogleSecretStore` a secas, así que conectar un WhatsApp
 * exigía un proyecto de Google Cloud — y como `partnerPorts` construye esto
 * ANTES de la primera llamada, el botón «Conectar WhatsApp» devolvía 503 sin
 * llegar a pedirle nada a Zavu. Zavu no tiene nada que ver con Google Cloud.
 *
 * ADR-0028: en la v1 la custodia es el disco cifrado del VPS y Secret Manager
 * es la opción. El calendario ya lo hacía bien; esto no. Ahora los dos usan el
 * MISMO selector, que vive en `@iaxti/google` para que no haya una tercera
 * versión.
 */
export function partnerSecretStore(): GoogleSecretStore {
  const custodia = custodiaDesdeEntorno(createGoogleSecretStore);
  if (!custodia) {
    throw new PartnerError(
      'PARTNER_NOT_CONFIGURED',
      'Falta decir dónde se guardan los secretos del canal. Pide a quien configura el servicio que defina GOOGLE_SECRET_DIR y GOOGLE_SECRET_KEY.',
      503,
    );
  }
  return custodia;
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
        /**
         * Un 404 es DEFINITIVO y el resto no (#1183).
         *
         * Acá todo fallo salía con el mismo error y el mismo consejo —«revisa
         * el estado antes de reintentar»—, que para un 404 es falso: un emisor
         * que Zavu borró no reaparece, y reintentar es lo único que seguro no
         * va a funcionar. Medido: las dos invitaciones completadas del tenant
         * de staging apuntan a emisores que hoy dan 404, y la conexión quedó
         * encerrada apretando ese botón.
         *
         * El cuerpo del proveedor sigue sin salir: lo que se conserva es que
         * el recurso no está, no lo que Zavu dijo de él.
         */
        if (response.status === 404) throw new PartnerError('PARTNER_RESOURCE_GONE','Zavu ya no tiene ese recurso. Hay que empezar la conexión de nuevo.',410);
        if (!response.ok) throw new PartnerError('PARTNER_PROVIDER_FAILED','Zavu no pudo completar este paso. Revisa el estado antes de reintentar.',502);
        const reader=response.body?.getReader(); let size=0; const chunks:Uint8Array[]=[];
        if (!reader) throw new Error('empty');
        try { for (;;) { const part=await reader.read(); if(part.done)break; size+=part.value.length; if(size>65536) {await reader.cancel(); throw new Error('size');} chunks.push(part.value); } } finally {reader.releaseLock();}
        const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('shape');
        return value as Record<string,unknown>;
      } catch (e) {
        // Un `PartnerError` ya clasificado pasa tal cual: este catch existe
        // para el timeout, el cuerpo gigante y el JSON roto, no para tragarse
        // la clasificación de arriba (#1183). Con un `catch` pelado, el 410
        // del recurso ausente salía convertido en 502 «reintenta», que es
        // exactamente el consejo equivocado.
        if (e instanceof PartnerError) throw e;
        throw new PartnerError('PARTNER_PROVIDER_FAILED','Zavu no pudo completar este paso. Revisa el estado antes de reintentar.',502);
      }
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
  /**
   * `connectedAccount` es OPCIONAL porque Zavu lo manda VACÍO (#1179).
   *
   * Medido contra la API de producción el 02-11, pidiendo el detalle de una
   * invitación que el panel de Zavu muestra como completada:
   *
   *     "status": "completed",
   *     "senderId": "kd7c40p7vkwmt4e33me44edwph8hdxfs",
   *     "connectedAccount": null,
   *     "phoneNumberId": null
   *
   * Acá se exigía `connected?.channel==='whatsapp'`, así que TODA invitación
   * completada lanzaba 502 y el onboarding por invitación no podía terminar
   * nunca. Y el mensaje que salía —«Zavu no confirmó el número conectado»— era
   * cierto desde donde estaba escrito y contradecía lo que el cliente veía en
   * el panel del proveedor, que decía completed.
   *
   * Lo opcional es que FALTE, no que mienta: si Zavu empieza a mandarlo, su
   * contenido se sigue validando igual que antes. Y el número no se pierde: lo
   * da la ficha del emisor, que `processPartnerInvitation` pide dos líneas
   * después y es la fuente de verdad del proveedor.
   */
  const connected=r.connectedAccount as {channel?:unknown;id?:unknown}|null|undefined;
  if(r.status==='completed' && (typeof r.senderId!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(r.senderId))) throw new PartnerError('PARTNER_RESPONSE_INVALID','Zavu no confirmó el número conectado.',502);
  if(connected!==null && connected!==undefined && (connected.channel!=='whatsapp' || typeof connected.id!=='string')) throw new PartnerError('PARTNER_RESPONSE_INVALID','Zavu no confirmó el número conectado.',502);
  return {id:r.id,url:r.url,status:String(r.status),expiresAt:String(r.expiresAt),senderId:typeof r.senderId==='string'?r.senderId:null,
    phoneNumberId:typeof connected?.id==='string'?connected.id:null,wabaId:null};
}
