// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const auth=vi.hoisted(()=>({tenant:'tenant-a',token:'session-a',user:'user-a',permissions:['integrations.read','integrations.connect']}));
const picker=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('../lib/google-picker',()=>({openGooglePicker:picker.open,prepareGooglePicker:vi.fn(async()=>{})}));
vi.mock('@iaxti/ui/react',async original=>({...await original<object>(),useSession:()=>({config:{apiUrl:'https://api.example.test'},session:{access_token:auth.token,user:{id:auth.user}}})}));
vi.mock('../components/tenant-switcher',()=>({useSelectedTenant:()=>auth.tenant}));
vi.mock('../components/arranque',()=>({useArranque:()=>({arranque:{permisos:auth.permissions,modulos:[{id:'integrations'}]}})}));
import {GoogleDriveConnection,GoogleDriveCallback} from '../components/google-drive';
import {DriveContextFiles} from '../components/google-drive-files';
import {saveGooglePending} from '../lib/google-oauth';
const fetcher=vi.fn<typeof fetch>();const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const disconnected={configured:true,status:'disconnected'};const active={configured:true,status:'active'};
const file={id:'file-id',fileId:'selected-google-file',name:'Contrato personal',mimeType:'text/plain',url:'https://drive.google.com/file/d/selected-google-file/view',aiAllowed:false,available:true,knowledgeReadable:true,passages:[]};
const empty={files:[],knowledgeAvailable:true,truncated:false,nextCursor:null};
beforeEach(()=>{auth.tenant='tenant-a';auth.user='user-a';auth.token='session-a';auth.permissions=['integrations.read','integrations.connect'];fetcher.mockReset();picker.open.mockReset();Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});vi.stubGlobal('fetch',fetcher);sessionStorage.clear();window.history.replaceState(null,'','/ajustes/drive');});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('conexión fallida muestra error/reintento sin declarar vacío; no permiso oculta mutación',async()=>{
  fetcher.mockResolvedValueOnce(json({code:'DOWN',message:'Reintenta más tarde.',requestId:'req'},503)).mockResolvedValueOnce(json(disconnected));
  render(<GoogleDriveConnection/>);await screen.findByText('DOWN · req');fireEvent.click(screen.getByRole('button',{name:'Reintentar'}));await screen.findByRole('button',{name:'Conectar Google Drive'});
});
it('archivo seleccionado inicia con IA apagada y opt-in explícito',async()=>{
  let allowed=false;fetcher.mockImplementation(async(url,init)=>{
    if(String(url).endsWith('/permiso-ia')){allowed=JSON.parse(String(init?.body)).allowed;return json({...file,aiAllowed:allowed});}
    if(String(url).endsWith('/buscar'))return json({...empty,files:[{...file,aiAllowed:allowed}]});return json(active);
  });render(<GoogleDriveConnection/>);const checkbox=await screen.findByRole('checkbox',{name:'Permitir que mi IA consulte este documento'});expect(checkbox).not.toBeChecked();fireEvent.click(checkbox);await waitFor(()=>expect(checkbox).toBeChecked());
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/permiso-ia'))).toHaveLength(1);
});
it('Picker revalida fileId en backend sin token y conserva IA apagada',async()=>{
  picker.open.mockResolvedValue('selected-google-file');let selected=false;
  fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith('/selector'))return json({clientId:'client',apiKey:'public',appId:'123'});if(String(url).endsWith('/seleccionar')){selected=true;expect(JSON.parse(String(init?.body))).toEqual({fileId:'selected-google-file',aiAllowed:false});return json(file);}if(String(url).endsWith('/buscar'))return json({...empty,files:selected?[file]:[]});return json(active);});
  render(<GoogleDriveConnection/>);fireEvent.click(await screen.findByRole('button',{name:'Elegir en Google Drive'}));await screen.findByText('Archivo autorizado para tu cuenta. La lectura por IA sigue apagada.');expect(picker.open).toHaveBeenCalledTimes(1);
});
it('cambio de tenant descarta resultados y selector tardío; no selecciona para contexto nuevo',async()=>{
  let finish!:(id:string)=>void;picker.open.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  fetcher.mockImplementation(async url=>String(url).endsWith('/buscar')?json(empty):String(url).endsWith('/selector')?json({clientId:'c',apiKey:'k',appId:'1'}):json(active));
  const view=render(<GoogleDriveConnection/>);fireEvent.click(await screen.findByRole('button',{name:'Elegir en Google Drive'}));await waitFor(()=>expect(picker.open).toHaveBeenCalledTimes(1));
  auth.tenant='tenant-b';view.rerender(<GoogleDriveConnection/>);await act(async()=>finish('old-file'));expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/seleccionar'))).toBe(false);
});
it('callback Drive rechaza state de Calendar antes del canje y quita código de URL',async()=>{
  const state='s'.repeat(43);saveGooglePending(state,{tenantId:auth.tenant,userId:auth.user,nonce:'n'.repeat(43),verifier:'v'.repeat(43),key:'test',createdAt:Date.now(),service:'calendar'});
  window.history.replaceState(null,'',`/integraciones/drive/callback?code=temporary&state=${state}`);render(<GoogleDriveCallback/>);await screen.findByText(/Este permiso no corresponde a Drive/);expect(fetcher).not.toHaveBeenCalled();expect(window.location.search).toBe('');
});
it('sin permiso conectar mantiene lectura y deshabilita consentimiento',async()=>{
  auth.permissions=['integrations.read'];fetcher.mockImplementation(async url=>String(url).endsWith('/buscar')?json({...empty,files:[file]}):json(active));render(<GoogleDriveConnection/>);
  expect(await screen.findByRole('checkbox')).toBeDisabled();expect(screen.queryByRole('button',{name:'Elegir en Google Drive'})).toBeNull();expect(screen.queryByRole('button',{name:'Revocar permisos'})).toBeNull();
});
it('ficha publica referencias sin conexión personal ni autoriza IA al equipo',async()=>{
  fetcher.mockImplementation(async url=>String(url).endsWith('/adjuntos')?json([{id:'ref',name:'Referencia compartida',url:file.url,mimeType:'text/plain',own:false}]):json(disconnected));
  render(<DriveContextFiles contactId="contact-a"/>);expect(fetcher).not.toHaveBeenCalled();const open=screen.getByRole('button',{name:'Ver archivos de Drive'});expect(open).toHaveAttribute('aria-expanded','false');fireEvent.click(open);await screen.findByRole('link',{name:'Referencia compartida'});expect(open).toHaveAttribute('aria-expanded','true');expect(screen.queryByRole('checkbox')).toBeNull();expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/buscar'))).toBe(false);
});
it('adjuntar y copias por contacto requieren acciones separadas; explica responsabilidad sobre copias',async()=>{
  let enabled=false;fetcher.mockImplementation(async(url,init)=>{const path=String(url);if(path.endsWith('/buscar'))return json({...empty,files:[file]});if(path.endsWith('/adjuntos'))return json([]);if(path.endsWith('/carpeta/estado'))return json({enabled,pending:0,retrying:0,uploaded:0,folderUrl:null});if(path.endsWith('/carpeta')){enabled=JSON.parse(String(init?.body)).enabled;return json({enabled});}if(path.endsWith('/adjuntar'))return json({attached:true,created:true});return json(active);});
  render(<DriveContextFiles contactId="contact-a" conversationId="conversation-a"/>);expect(fetcher).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Ver archivos de Drive'}));fireEvent.click(await screen.findByRole('button',{name:'Adjuntar Contrato personal'}));await screen.findByText('Referencia adjuntada. No se envió ningún mensaje.');expect(enabled).toBe(false);
  expect(screen.getByText(/copias que tú administras en Google Drive/)).toBeTruthy();const checkbox=screen.getByRole('checkbox');fireEvent.click(checkbox);await waitFor(()=>expect(checkbox).toBeChecked());
});

it.each(['tenant','user','token','contact','conversation'] as const)('cambio de %s cierra Drive contextual y descarta la respuesta anterior sin cargar el nuevo contexto',async(change)=>{
  let finish!:(value:Response)=>void;
  fetcher.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;})).mockImplementation(async url=>String(url).endsWith('/adjuntos')?json([]):json(disconnected));
  const view=render(<DriveContextFiles contactId="contact-a" conversationId="conversation-a"/>);
  fireEvent.click(screen.getByRole('button',{name:'Ver archivos de Drive'}));expect(fetcher).toHaveBeenCalledTimes(1);
  if(change==='tenant')auth.tenant='tenant-b';if(change==='user')auth.user='user-b';if(change==='token')auth.token='session-b';
  view.rerender(<DriveContextFiles contactId={change==='contact'?'contact-b':'contact-a'} conversationId={change==='conversation'?'conversation-b':'conversation-a'}/>);
  expect(screen.getByRole('button',{name:'Ver archivos de Drive'})).toHaveAttribute('aria-expanded','false');expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async()=>finish(json([{id:'old-ref',name:'Archivo del contexto anterior',url:file.url,mimeType:'text/plain',own:false}])));
  expect(screen.queryByRole('link',{name:'Archivo del contexto anterior'})).toBeNull();expect(screen.queryByRole('region',{name:'Archivos de Drive en esta ficha'})).toBeNull();
  const before=fetcher.mock.calls.length;fireEvent.click(screen.getByRole('button',{name:'Ver archivos de Drive'}));await screen.findByText('Las referencias que adjuntes aparecerán aquí.');expect(fetcher.mock.calls.length).toBeGreaterThan(before);
});

it('abre GIS desde el clic sin esperar la segunda acreditación del servidor; no selecciona antes de ambas',async()=>{
  let finish!:()=>void;let calls=0;picker.open.mockResolvedValue('selected-google-file');
  fetcher.mockImplementation(async url=>{if(String(url).endsWith('/selector')){if(++calls===2)await new Promise<void>(resolve=>{finish=resolve;});return json({clientId:'c',apiKey:'k',appId:'1'});}if(String(url).endsWith('/buscar'))return json(empty);return json(active);});
  render(<GoogleDriveConnection/>);fireEvent.click(await screen.findByRole('button',{name:'Elegir en Google Drive'}));
  expect(picker.open).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/seleccionar'))).toBe(false);
  await act(async()=>finish());await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/seleccionar'))).toBe(true));
});
