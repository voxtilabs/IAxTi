'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {gmailClient,GmailSdkError,type GmailState,type GmailThreadResult} from '@iaxti/sdk';
import {AvisoResultado,Badge,Button,Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle,EncabezadoDePagina,EstadoVacio,Skeleton,useSession} from '@iaxti/ui/react';
import {useSelectedTenant} from '../tenant-switcher';
import {useArranque} from '../arranque';
import {clearGooglePending,googlePkce,readGooglePending,saveGooglePending} from '../../lib/google-oauth';
function failure(error:unknown){return{texto:error instanceof Error?error.message:'No pudimos consultar Gmail. Intenta de nuevo.',rastro:error instanceof GmailSdkError?[error.code,error.requestId].filter(Boolean).join(' · '):null};}
function Notice({error}:{error:ReturnType<typeof failure>|null}){return error?<AvisoResultado persistente tono="error">{error.texto}{error.rastro&&<p className="mt-2 break-all font-mono text-xs">{error.rastro}</p>}</AvisoResultado>:null;}
export function GmailContacto({contactId,email}:{contactId:string;email:string|null}){
  const{config,session}=useSession();const tenantId=useSelectedTenant();const{arranque}=useArranque();
  if(!session||!tenantId)return null;
  if(arranque?.modulos&&!arranque.modulos.some(m=>m.id==='integrations'))return null;
  const canRead=arranque?.permisos==null||arranque.permisos.includes('integrations.read');
  if(!canRead)return <section className="mt-6" aria-label="Correo de Gmail"><h2 className="text-lg font-bold text-ink">Correo de Gmail</h2><p className="mt-2 text-sm text-body">Tu rol no permite leer Gmail. Pide acceso a quien administra el equipo.</p></section>;
  return <Panel key={`${tenantId}|${session.access_token}|${contactId}|${email}`} apiUrl={config.apiUrl} token={session.access_token} tenantId={tenantId} userId={session.user.id} contactId={contactId} email={email}
    canConnect={Boolean(arranque?.permisos?.includes('integrations.connect'))}/>;
}
function Panel({apiUrl,token,tenantId,userId,contactId,email,canConnect}:{apiUrl:string;token:string;tenantId:string;userId:string;contactId:string;email:string|null;canConnect:boolean}){
  const client=useMemo(()=>gmailClient({apiUrl,token,tenantId}),[apiUrl,token,tenantId]);
  const[state,setState]=useState<GmailState|null>(null);const[data,setData]=useState<GmailThreadResult|null>(null);const[error,setError]=useState<ReturnType<typeof failure>|null>(null);
  const[loading,setLoading]=useState(true);const[busy,setBusy]=useState(false);const[confirm,setConfirm]=useState(false);const[attempt,setAttempt]=useState(0);
  const alive=useRef(true);const flight=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    const abort=new AbortController();setLoading(true);setError(null);
    void(async()=>{try{const status=await client.state(abort.signal);if(abort.signal.aborted)return;setState(status);
      if(status.status==='active'&&email){const result=await client.threads(contactId,attempt>0,abort.signal);if(!abort.signal.aborted)setData(result);}else setData(null);
    }catch(e){if(!abort.signal.aborted){setData(null);setError(failure(e));}}finally{if(!abort.signal.aborted)setLoading(false);}})();
    return()=>abort.abort();
  },[client,contactId,email,attempt]);
  async function connect(){if(flight.current)return;flight.current=true;setBusy(true);setError(null);
    try{const{verifier,challenge}=await googlePkce();const pending=await client.start(challenge);if(!alive.current)return;
      const url=new URL(pending.url);if(url.origin!=='https://accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth')throw new Error('No pudimos abrir el permiso de Google. Intenta nuevamente.');
      saveGooglePending(pending.state,{service:'gmail',verifier,nonce:pending.nonce,tenantId,userId,createdAt:Date.now(),key:crypto.randomUUID()});window.location.assign(url.href);
    }catch(e){if(alive.current)setError(failure(e));}finally{if(alive.current){flight.current=false;setBusy(false);}}
  }
  async function revoke(){if(flight.current)return;flight.current=true;setBusy(true);setError(null);setData(null);
    try{await client.revoke(crypto.randomUUID());if(alive.current){setState({configured:true,status:'revoked',pushActive:false,lastNotificationAt:null});setConfirm(false);}}
    catch(e){if(alive.current){setError(failure(e));setState(s=>s?{...s,status:'revoking',pushActive:false}:s);}}
    finally{if(alive.current){flight.current=false;setBusy(false);}}
  }
  const linked=state&&!['disconnected','revoked'].includes(state.status);
  return <section className="mt-6 min-w-0 rounded-tarjeta border border-line bg-raised p-4" aria-label="Correo de Gmail" aria-busy={loading||busy}>
    <h2 className="text-lg font-bold text-ink">Correo de Gmail</h2>
    <p className="mt-1 text-sm text-body">Solo tú ves los hilos de tu cuenta con este contacto. Mostramos asunto y extracto; no enviamos correos ni los guardamos como conocimiento.</p>
    <div className="mt-3"><Notice error={error}/></div>
    {loading?<div role="status" aria-label="Cargando correo de Gmail" className="mt-3 space-y-2"><Skeleton className="h-16 w-full"/><Skeleton className="h-16 w-full"/></div>:<>
      {!email?<EstadoVacio compacto titulo="Falta el correo del contacto" descripcion="Los hilos aparecerán cuando agregues su correo a la ficha." accion={{etiqueta:'Editar contacto',href:`/contactos/${contactId}`}}/>:
      data?.state==='no_email'?<p className="mt-3 text-sm text-body">El contacto ya no tiene correo. Actualiza su ficha para consultar los hilos.</p>:
      data?<>
        {data.truncated&&<AvisoResultado persistente tono="warning">Esta consulta alcanzó su límite. El orden corresponde a los hilos recuperados; puede haber más en Gmail.</AvisoResultado>}
        {data.threads.length===0?<EstadoVacio compacto titulo="Sin correos con este contacto" descripcion="Aquí aparecerán los hilos de tu cuenta que incluyan su correo exacto." accion={{etiqueta:'Consultar de nuevo',onClick:()=>setAttempt(n=>n+1)}}/>:
        <ul className="mt-3 space-y-3" aria-label="Hilos de Gmail">{data.threads.map(thread=><li key={thread.id} className="min-w-0 rounded-campo border border-line p-3">
          <h3 className="break-words text-sm font-semibold text-ink">{thread.subject||'Sin asunto'}</h3><p className="mt-1 break-words text-sm text-body">{thread.snippet||'Sin extracto disponible.'}</p><time className="mt-2 block font-mono text-xs text-muted" dateTime={thread.lastMessageAt}>{new Date(thread.lastMessageAt).toLocaleString('es-CL')}</time>
        </li>)}</ul>}
        {!data.pushActive&&<p className="mt-3 text-sm text-body">Las notificaciones están pendientes. Usa «Consultar de nuevo» para traer los cambios.</p>}
      </>:state?.status==='active'?null:state?<div className="mt-3"><Badge role="neutral">{state.status==='revoking'?'Revocación pendiente':state.status==='reauth_required'?'Necesita autorización':'Sin conectar'}</Badge><p className="mt-2 text-sm text-body">{!state.configured?'Gmail aún no está habilitado en este entorno. Pide ayuda al equipo de soporte.':state.status==='revoking'?'El acceso ya está bloqueado aquí. Reintenta la revocación para terminar.':'Conecta tu cuenta personal para ver su correo junto a la historia del contacto.'}</p></div>:null}
      <div className="mt-4 flex flex-wrap gap-2">
        {(error||(state?.status==='active'&&data?.threads.length!==0))&&<Button variant="secundario" disabled={busy} onClick={()=>setAttempt(n=>n+1)}>Consultar de nuevo</Button>}
        {state?.configured&&canConnect&&state.status!=='revoking'&&state.status!=='active'&&<Button variant="secundario" disabled={busy} onClick={()=>void connect()}>{busy?'Un momento…':'Conectar Gmail'}</Button>}
        {linked&&canConnect&&<Button variant="fantasma" disabled={busy} onClick={()=>setConfirm(true)}>Revocar permisos Google</Button>}
      </div>
    </>}
    <Dialog open={confirm} onOpenChange={v=>{if(!busy)setConfirm(v);}}><DialogContent><DialogHeader><DialogTitle>Revocar permisos de Google</DialogTitle><DialogDescription>Google retirará todos los permisos de esta cuenta concedidos a IAxTi, también Calendar, Drive y los usados en otros negocios. Para volver a usarlos tendrás que autorizar de nuevo.</DialogDescription></DialogHeader><Notice error={error}/><DialogFooter className="flex-col sm:flex-row"><Button variant="fantasma" disabled={busy} onClick={()=>setConfirm(false)}>Volver</Button><Button disabled={busy} onClick={()=>void revoke()}>{busy?'Revocando…':'Confirmar revocación'}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
export function GmailCallback(){
  const{config,session}=useSession();const tenantId=useSelectedTenant();const[params,setParams]=useState<URLSearchParams|null>(null);const captured=useRef<URLSearchParams|null>(null);
  useEffect(()=>{captured.current??=new URLSearchParams(window.location.search);window.history.replaceState(null,'',window.location.pathname);setParams(captured.current);},[]);
  if(!session||!tenantId||!params)return <p role="status">Esperando tu sesión para terminar la conexión…</p>;
  return <Finish key={`${tenantId}|${session.access_token}`} apiUrl={config.apiUrl} token={session.access_token} tenantId={tenantId} userId={session.user.id} params={params}/>;
}
function Finish({apiUrl,token,tenantId,userId,params}:{apiUrl:string;token:string;tenantId:string;userId:string;params:URLSearchParams}){
  const[result,setResult]=useState<GmailState|null>(null);const[error,setError]=useState<ReturnType<typeof failure>|null>(null);const promise=useRef<Promise<GmailState>|null>(null);
  useEffect(()=>{let cancelled=false;promise.current??=(async()=>{const state=params.get('state')??'';const pending=readGooglePending(state,tenantId,userId);
    if(pending.service!=='gmail')throw new Error('Este permiso pertenece a otra integración. Inicia Gmail desde la ficha del contacto.');
    try{if(params.has('error'))throw new Error('No autorizaste Gmail. Puedes volver a conectar desde la ficha del contacto.');const code=params.get('code');if(!code)throw new Error('Google no entregó el permiso. Vuelve a conectar Gmail.');return await gmailClient({apiUrl,token,tenantId}).finish({state,code,nonce:pending.nonce,verifier:pending.verifier},pending.key);}finally{clearGooglePending(state);}})();
    void promise.current.then(value=>{if(!cancelled)setResult(value);},e=>{if(!cancelled)setError(failure(e));});return()=>{cancelled=true;};
  },[apiUrl,token,tenantId,userId,params]);
  return <section className="pulso-panel rounded-tarjeta border border-line bg-raised p-4"><EncabezadoDePagina titulo="Conexión de Gmail"/><Notice error={error}/>{result?<AvisoResultado persistente tono="success">{result.pushActive?'Tu Gmail quedó conectado. Abre la ficha de un contacto para consultar sus hilos.':'El permiso quedó guardado. Las notificaciones siguen pendientes; puedes consultar los hilos desde la ficha.'}</AvisoResultado>:!error&&<p role="status" className="mt-3 text-sm text-body">Guardando tu permiso…</p>}<a href="/contactos" className="mt-4 inline-block text-action-text underline">Volver a contactos</a></section>;
}
