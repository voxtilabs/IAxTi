'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Skeleton, useSession } from '@iaxti/ui/react';
import { partnerClient, type PartnerInvitationState } from '@iaxti/sdk';
import { avisoDe, type Aviso } from '../lib/api';

export function WhatsAppInvitation({tenant,primary=false}:{tenant:string;primary?:boolean}) {
  const {session,config}=useSession();
  if(!session)return null;
  return <Invitation key={`${tenant}:${session.access_token}:${config.apiUrl}`} tenant={tenant} token={session.access_token} apiUrl={config.apiUrl} primary={primary}/>;
}
const words:Record<string,string>={
  none:'Conecta tu número con Facebook. El enlace se guarda para que puedas retomar este paso.',
  creating:'Estamos preparando tu invitación. Puedes volver a revisar este paso.',
  pending:'Abre la invitación y autoriza tu número en Facebook. Al terminar conectaremos WhatsApp automáticamente.',
  connecting:'El número está confirmado. Falta completar su conexión segura.',
  provisioning:'Estamos comprobando el webhook y la custodia de la conexión.',
  recovery_required:'No pudimos confirmar la conexión segura. El canal sigue sin activarse. Puedes reintentar este paso.',
  ambiguous:'No pudimos confirmar si Zavu creó la invitación. No crearemos otra automáticamente. Pide ayuda para revisar este intento.',
  disconnected:'La cuenta fue desconectada. Revisa el canal antes de iniciar otra conexión.',
  active:'WhatsApp está conectado. Escríbele desde otro teléfono para ver la primera conversación.',
  checking_expiry:'El enlace venció. Estamos comprobando si la autorización terminó antes de crear otra invitación.',
  expired:'La invitación venció. Puedes crear una nueva para conectar tu número.',
  cancelled:'La invitación fue cancelada. Puedes crear una nueva.',
  failed:'La invitación no terminó. Puedes volver a abrir el mismo enlace.',
};
function Invitation({tenant,token,apiUrl,primary}:{tenant:string;token:string;apiUrl:string;primary:boolean}) {
  const [data,setData]=useState<PartnerInvitationState|null>(null);
  const [error,setError]=useState<Aviso|null>(null);
  const [busy,setBusy]=useState(false);
  const alive=useRef(true);const abort=useRef(new AbortController());const sequence=useRef(0);const mutation=useRef(false);
  const key=useRef<string|null>(null);
  const client=useCallback(()=>partnerClient({apiUrl,token,tenantId:tenant}),[apiUrl,token,tenant]);
  const load=useCallback(async()=>{
    const seq=++sequence.current;
    try{const value=await client().status(abort.current.signal);if(alive.current&&seq===sequence.current){setData(value);setError(null);}}
    catch(e){if(alive.current&&seq===sequence.current){setError(avisoDe(e));if((e as {status?:number}).status===403)setData(null);}}
  },[client]);
  useEffect(()=>{alive.current=true;abort.current=new AbortController();void load();const refresh=()=>void load();window.addEventListener('focus',refresh);
    return()=>{alive.current=false;abort.current.abort();window.removeEventListener('focus',refresh);};},[load]);
  useEffect(()=>{if(!data||!['creating','pending','checking_expiry','connecting','provisioning'].includes(data.phase))return;
    const timer=setInterval(()=>{if(!mutation.current)void load();},5000);return()=>clearInterval(timer);
  },[data,load]);
  async function act(start:boolean){
    if(mutation.current)return;mutation.current=true;setBusy(true);setError(null);sequence.current++;
    try{
      if(start){key.current??=crypto.randomUUID();const value=await client().start(key.current,abort.current.signal);if(alive.current)setData(value);}
      else if(data?.id){await client().resume(data.id,abort.current.signal);if(alive.current)await load();}
    }catch(e){if(alive.current)setError(avisoDe(e));}
    finally{mutation.current=false;if(alive.current)setBusy(false);}
  }
  const phase=data?.phase;
  const canStart=phase==='none'||phase==='expired'||phase==='cancelled';
  return <section aria-label="Conexión de WhatsApp" className="w-full min-w-0 rounded-campo border border-line bg-rest p-4">
    {!data&&!error?<div role="status" aria-label="Cargando conexión"><Skeleton className="h-5 w-3/4"/><Skeleton className="mt-3 h-12 w-full"/></div>:<>
      {data&&<p role="status" className="text-sm text-body">{data.providerStatus==='failed'?'No se terminó la autorización en Facebook. El mismo enlace permite intentarlo otra vez.':words[data.phase]??'Revisa el estado de la conexión.'}</p>}
      {error&&<div role="alert" className="mt-2 text-sm text-bad-text"><p>{error.texto}</p>{error.rastro&&<p className="dato mt-1 break-all text-xs">{error.rastro}</p>}</div>}
      {data?.errorCode==='PARTNER_OTHER_INVITATION_CHANGED'&&<p role="alert" className="mt-2 text-sm text-warn-text">Una invitación anterior cambió en Zavu. Conservamos este intento; pide ayuda para revisar la anterior.</p>}
      {data?.errorCode&&<p className="dato mt-2 break-all text-xs text-muted">{data.errorCode}</p>}
      {data?.url&&phase==='pending'&&<a href={data.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="mt-3 inline-block text-action-text underline underline-offset-4">Continuar con Facebook</a>}
      {data?.expiresAt&&phase==='pending'&&<p className="mt-2 text-xs text-muted">Disponible hasta <span className="dato">{new Date(data.expiresAt).toLocaleDateString('es-CL',{timeZone:'America/Santiago'})}</span>.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {canStart&&<Button className="!h-auto min-h-control py-2" variant={primary?'primario':'secundario'} disabled={busy} onClick={()=>{if(phase!=='none')key.current=null;void act(true);}}>{busy?'Preparando invitación…':'Conectar WhatsApp'}</Button>}
        {data?.id&&['pending','checking_expiry','connecting','recovery_required','failed'].includes(data.phase)&&<Button className="!h-auto min-h-control py-2" variant="secundario" disabled={busy} onClick={()=>void act(false)}>{busy?'Revisando…':phase==='recovery_required'?'Reintentar conexión segura':'Revisar conexión'}</Button>}
        <Button className="!h-auto min-h-control py-2" variant="fantasma" disabled={busy} onClick={()=>void load()}>Actualizar estado</Button>
      </div>
    </>}
  </section>;
}
