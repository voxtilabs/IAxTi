'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { googleDriveClient, GoogleDriveSdkError, type DriveSearchResult, type DriveContext, type DriveReference, type DriveFolderState } from '@iaxti/sdk';
import { AvisoResultado, Button, Checkbox, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { useArranque } from './arranque';
import { useSelectedTenant } from './tenant-switcher';
import { openGooglePicker, prepareGooglePicker } from '../lib/google-picker';

const errorMessage=(cause:unknown)=>cause instanceof GoogleDriveSdkError?`${cause.message} · ${[cause.code,cause.requestId].filter(Boolean).join(' · ')}`:cause instanceof Error?cause.message:'No pudimos consultar Drive. Intenta otra vez.';

interface Props {apiUrl:string;token:string;tenantId:string;canConnect:boolean;context?:DriveContext}
export function DriveFiles({apiUrl,token,tenantId,canConnect,context}:Props){
  const client=useMemo(()=>googleDriveClient({apiUrl,token,tenantId}),[apiUrl,token,tenantId]);
  const [data,setData]=useState<DriveSearchResult|null>(null);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [query,setQuery]=useState('');const queryValue=useRef('');const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);
  const [pickerConfig,setPickerConfig]=useState<Awaited<ReturnType<typeof client.picker>>|null>(null);const [pickerAttempt,setPickerAttempt]=useState(0);
  const [references,setReferences]=useState<DriveReference[]>([]);const [folder,setFolder]=useState<DriveFolderState|null>(null);
  const active=useRef(true);const flight=useRef(false);const generation=useRef(0);const picker=useRef<AbortController|null>(null);
  useEffect(()=>{active.current=true;const requests=generation;return()=>{active.current=false;requests.current++;picker.current?.abort();};},[]);
  const contactId=context?.contactId;const conversationId=context?.conversationId;const contextual=Boolean(context);
  useEffect(()=>{if(contextual||!canConnect)return;let cancelled=false;void Promise.all([prepareGooglePicker(),client.picker()]).then(([,config])=>{if(!cancelled)setPickerConfig(config);},cause=>{if(!cancelled)setError(errorMessage(cause));});return()=>{cancelled=true;};},[client,contextual,canConnect,pickerAttempt]);
  const load=useCallback(async(after?:string)=>{
    const context=contactId?{contactId,...(conversationId?{conversationId}:{})}:undefined;
    const id=++generation.current;setLoading(true);setError('');
    try{
      const refs=context?await client.references(context):[];
      const connected=context?(await client.state()).status==='active':true;
      const next=connected?await client.search({query:queryValue.current,...(context?{context}:{}),...(after?{after}:{})}):{files:[],knowledgeAvailable:false,truncated:false,nextCursor:null};
      const copies=contactId&&connected?await client.folder(contactId):null;
      if(active.current&&id===generation.current){setData(next);setReferences(refs);setFolder(copies);}
    }catch(cause){if(active.current&&id===generation.current)setError(errorMessage(cause));}
    finally{if(active.current&&id===generation.current)setLoading(false);}
  },[client,contactId,conversationId]);
  useEffect(()=>{const requests=generation;void load();return()=>{requests.current++;};},[load]);
  async function action(operation:()=>Promise<void>){
    if(flight.current)return;flight.current=true;setBusy(true);setError('');setNotice('');
    try{await operation();}catch(cause){if(active.current)setError(errorMessage(cause));}
    finally{if(active.current){flight.current=false;setBusy(false);}}
  }
  async function choose(){
    picker.current?.abort();const abort=new AbortController();picker.current=abort;
    if(!pickerConfig)return;
    try{
      // GIS starts during the user's click; no network round trip before its popup.
      // The server rechecks and audits preparation again before accepting a selection.
      const [,fileId]=await Promise.all([client.picker(),openGooglePicker(pickerConfig,abort.signal)]);
      if(!fileId||!active.current||abort.signal.aborted)return;
      await client.select(fileId,crypto.randomUUID());if(active.current){setNotice('Archivo autorizado para tu cuenta. La lectura por IA sigue apagada.');await load();}
    }finally{abort.abort();}
  }
  return <section className="mt-4 min-w-0 space-y-3" aria-label={context?'Archivos de Drive en esta ficha':'Mis archivos autorizados'} aria-busy={loading||busy}>
    <h3 className="font-medium text-ink">{context?'Archivos de Drive':'Mis archivos autorizados'}</h3>
    <p className="text-sm text-body">Solo se muestran los archivos que elegiste. Adjuntar comparte la referencia con el equipo; conserva los permisos de Google.</p>
    {error&&<AvisoResultado persistente tono="error">{error}</AvisoResultado>}{notice&&<AvisoResultado persistente tono="success">{notice}</AvisoResultado>}
    <form className="flex flex-wrap items-end gap-2" onSubmit={e=>{e.preventDefault();void load();}}>
      <div className="min-w-0 flex-1"><label htmlFor="drive-search" className="text-sm text-body">Buscar entre mis archivos</label><Input id="drive-search" value={query} maxLength={200} onChange={e=>{queryValue.current=e.target.value;setQuery(e.target.value);}} /></div>
      <Button variant="secundario" type="submit" disabled={busy||loading}>Buscar</Button>
    </form>
    {!context&&canConnect&&!pickerConfig&&<Button variant="secundario" disabled={busy} onClick={()=>setPickerAttempt(n=>n+1)}>Cargar selector de Google</Button>}
    {!context&&canConnect&&pickerConfig&&<Button variant="secundario" disabled={busy} onClick={()=>void action(choose)}>Elegir en Google Drive</Button>}
    {context&&<a href="/ajustes/drive" className="inline-block text-sm text-action-text underline">Autorizar otros archivos en Google Drive</a>}
    {loading&&!data?<Skeleton className="h-20 w-full" />:data&&data.files.length===0?<p className="text-sm text-muted">No hay archivos para esta búsqueda. Elige uno en Google Drive para empezar.</p>:<ul className="space-y-3">
      {data?.files.map(file=><li key={file.id} className="rounded-campo border border-line p-3">
        <a href={file.url} target="_blank" rel="noopener noreferrer" className="break-words text-action-text underline">{file.name}</a>
        {!file.available?<p className="mt-2 text-sm text-bad-text">No pudimos verificar el acceso. Revisa el archivo y vuelve a buscar.</p>:<>
          {!context&&<label className="mt-2 flex min-h-control items-center gap-2 text-sm text-body"><Checkbox checked={file.aiAllowed} disabled={!canConnect||busy||!data?.knowledgeAvailable||!file.knowledgeReadable} onCheckedChange={value=>void action(async()=>{await client.allowAi(file.id,value===true,crypto.randomUUID());if(active.current)await load();})} />Permitir que mi IA consulte este documento</label>}
          {!context&&!file.knowledgeReadable&&<p className="text-sm text-muted">Disponible como adjunto. La IA consulta texto, Docs, Sheets y Slides; no PDF ni imágenes.</p>}
          {context&&canConnect&&<Button variant="secundario" className="mt-2" disabled={busy||references.some(ref=>ref.selectedId===file.id)} onClick={()=>void action(async()=>{await client.attach(file.id,context,crypto.randomUUID());if(active.current){setNotice('Referencia adjuntada. No se envió ningún mensaje.');await load();}})}>{references.some(ref=>ref.selectedId===file.id)?'Ya adjuntado':`Adjuntar ${file.name}`}</Button>}
        </>}
      </li>)}
    </ul>}
    {data&&!data.knowledgeAvailable&&!context&&<p className="text-sm text-muted">La lectura por IA necesita el módulo de conocimiento y tu permiso para consultarlo.</p>}
    {data?.truncated&&<div className="space-y-2"><p className="text-sm text-muted">Mostramos una parte de los resultados para que la consulta sea rápida.</p><Button variant="secundario" disabled={busy||loading} onClick={()=>void load(data.nextCursor??undefined)}>{data.nextCursor?'Ver siguientes archivos':'Reintentar búsqueda'}</Button></div>}
    {context&&<><h4 className="font-medium text-ink">Referencias compartidas</h4>{references.length?<ul className="space-y-2">{references.map(file=><li key={file.id}><a href={file.url} target="_blank" rel="noopener noreferrer" className="break-words text-sm text-action-text underline">{file.name}</a></li>)}</ul>:<p className="text-sm text-muted">Las referencias que adjuntes aparecerán aquí.</p>}</>}
    {folder&&contactId&&<div className="border-t border-line pt-3"><label className="flex min-h-control items-center gap-2 text-sm text-body"><Checkbox checked={folder.enabled} disabled={!canConnect||busy} onCheckedChange={value=>void action(async()=>{await client.configureFolder(contactId,value===true,crypto.randomUUID());if(active.current)await load();})} />Guardar nuevos adjuntos recibidos de este contacto en mi Drive</label>
      <p className="text-sm text-muted">Se crea una carpeta por contacto con copias que tú administras en Google Drive. Se copian solo adjuntos nuevos mientras esté activo. Desactivar o suprimir el contacto en IAxTi no borra esas copias: debes administrarlas también en Google.</p>
      <p className="text-sm text-body">Copiados: <span className="font-mono">{folder.uploaded}</span> · Pendientes: <span className="font-mono">{folder.pending}</span> · Reintentando: <span className="font-mono">{folder.retrying}</span></p>
      {folder.lastUploadedAt&&<p className="text-sm text-body">Última copia: <time className="font-mono" dateTime={folder.lastUploadedAt}>{new Date(folder.lastUploadedAt).toLocaleString('es-CL')}</time></p>}
      {folder.nextAttemptAt&&<p className="text-sm text-body">Próximo intento: <time className="font-mono" dateTime={folder.nextAttemptAt}>{new Date(folder.nextAttemptAt).toLocaleString('es-CL')}</time></p>}
      {folder.folderUrl&&<a href={folder.folderUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-action-text underline">Abrir mi carpeta del contacto</a>}
    </div>}
  </section>;
}
export function DriveContextFiles({contactId,conversationId}:{contactId:string;conversationId?:string}){
  const {config,session}=useSession();const tenantId=useSelectedTenant();const {arranque}=useArranque();
  if(!session||!tenantId||!arranque?.permisos?.includes('integrations.read')||!arranque.modulos.some(module=>module.id==='integrations'))return null;
  return <DriveFiles key={`${tenantId}|${session.user.id}|${session.access_token}|${contactId}|${conversationId??''}`} apiUrl={config.apiUrl} token={session.access_token} tenantId={tenantId} context={{contactId,...(conversationId?{conversationId}:{})}} canConnect={arranque.permisos.includes('integrations.connect')} />;
}
