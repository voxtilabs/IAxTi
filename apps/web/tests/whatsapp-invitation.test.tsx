// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {WhatsAppInvitation} from '../components/whatsapp-invitation';
import {RegistrationError} from '@iaxti/sdk';
const mock=vi.hoisted(()=>({status:vi.fn(),start:vi.fn(),resume:vi.fn(),session:{access_token:'one'},config:{apiUrl:'https://api.test'},configs:[] as Array<{token:string;tenantId:string}>}));
vi.mock('@iaxti/sdk',async original=>({...await original<object>(),partnerClient:(config:{token:string;tenantId:string})=>{mock.configs.push(config);return {status:mock.status,start:mock.start,resume:mock.resume};}}));
vi.mock('@iaxti/ui/react',async original=>({...await original<object>(),useSession:()=>({session:mock.session,config:mock.config})}));
const state=(phase='none')=>({id:phase==='none'?null:'attempt',phase,providerStatus:null,url:null,expiresAt:null,accountId:null,errorCode:null});
beforeEach(()=>{vi.clearAllMocks();mock.configs=[];mock.session={access_token:'one'};mock.status.mockResolvedValue(state());mock.resume.mockResolvedValue({queued:true});});
afterEach(cleanup);
it('carga, vacío y POST único con doble clic; conserva enlace privado sin abrirlo automáticamente',async()=>{
 let finish!:(value:unknown)=>void;mock.start.mockImplementation(()=>new Promise(r=>{finish=r;}));
 render(<WhatsAppInvitation tenant="a"/>);expect(screen.getByRole('status',{name:'Cargando conexión'})).toBeInTheDocument();
 await userEvent.dblClick(await screen.findByRole('button',{name:'Conectar WhatsApp'}));expect(mock.start).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Preparando invitación…'})).toBeDisabled();
 await act(async()=>finish({...state('pending'),url:'https://dashboard.zavu.dev/invite/synthetic'}));const link=screen.getByRole('link',{name:'Continuar con Facebook'});expect(link).toHaveAttribute('rel','noopener noreferrer');expect(link).toHaveAttribute('referrerPolicy','no-referrer');
});
it('ambigüedad no ofrece recrear ni recuperar a ciegas; recuperación explícita sí encola',async()=>{
 mock.status.mockResolvedValue({...state('ambiguous'),errorCode:'PARTNER_CREATE_UNCERTAIN'});const view=render(<WhatsAppInvitation tenant="a"/>);
 expect(await screen.findByText(/No crearemos otra automáticamente/)).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Conectar WhatsApp'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Reintentar conexión segura'})).not.toBeInTheDocument();
 mock.status.mockResolvedValue(state('recovery_required'));await userEvent.click(screen.getByRole('button',{name:'Actualizar estado'}));await userEvent.click(await screen.findByRole('button',{name:'Reintentar conexión segura'}));expect(mock.resume).toHaveBeenCalledWith('attempt',expect.any(AbortSignal));view.unmount();
});
it('falla con rastro y reintento; 403 retira el enlace anterior',async()=>{
 mock.status.mockResolvedValue({...state('pending'),url:'https://dashboard.zavu.dev/invite/synthetic'});render(<WhatsAppInvitation tenant="a"/>);await screen.findByRole('link');
 mock.status.mockRejectedValue(new RegistrationError('FORBIDDEN','No tienes permiso.',403,'req_abc'));await userEvent.click(screen.getByRole('button',{name:'Actualizar estado'}));expect(await screen.findByRole('alert')).toHaveTextContent('FORBIDDEN · req_abc');expect(screen.queryByRole('link')).not.toBeInTheDocument();
 mock.status.mockResolvedValue(state());await userEvent.click(screen.getByRole('button',{name:'Actualizar estado'}));expect(await screen.findByRole('button',{name:'Conectar WhatsApp'})).toBeInTheDocument();
});
it.each(['tenant','session'])('respuesta tardía anterior no filtra el enlace al cambiar %s',async(kind)=>{
 let finish!:(value:unknown)=>void;mock.status.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));const view=render(<WhatsAppInvitation tenant="a"/>);await waitFor(()=>expect(mock.status).toHaveBeenCalledTimes(1));
 if(kind==='session')mock.session={access_token:'two'};view.rerender(<WhatsAppInvitation tenant={kind==='tenant'?'b':'a'}/>);await screen.findByRole('button',{name:'Conectar WhatsApp'});
 await act(async()=>finish({...state('pending'),url:'https://dashboard.zavu.dev/invite/old'}));expect(screen.queryByRole('link')).not.toBeInTheDocument();expect(mock.status.mock.calls[0]![0].aborted).toBe(true);
});
it('respuesta POST tardía al cambiar de negocio no sustituye su estado',async()=>{
 let finish!:(value:unknown)=>void;mock.start.mockImplementation(()=>new Promise(r=>{finish=r;}));const view=render(<WhatsAppInvitation tenant="a"/>);await userEvent.click(await screen.findByRole('button',{name:'Conectar WhatsApp'}));view.rerender(<WhatsAppInvitation tenant="b"/>);await screen.findByRole('button',{name:'Conectar WhatsApp'});
 await act(async()=>finish({...state('active'),accountId:'old'}));expect(screen.queryByText(/está conectado/)).not.toBeInTheDocument();
});
