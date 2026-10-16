// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {openGooglePicker} from '../lib/google-picker';
let consent:Record<string,unknown>;let callback:(data:unknown)=>void;let dispose:ReturnType<typeof vi.fn>;let setOAuthToken:ReturnType<typeof vi.fn>;
const config={clientId:'public-client',apiKey:'public-key',appId:'1234'};
beforeEach(()=>{
  consent={};dispose=vi.fn();setOAuthToken=vi.fn();
  class Builder {addView(){return this;}setOAuthToken(value:string){setOAuthToken(value);return this;}setDeveloperKey(){return this;}setAppId(){return this;}setOrigin(){return this;}setCallback(fn:(data:unknown)=>void){callback=fn;return this;}build(){return {setVisible:vi.fn(),dispose};}}
  Object.assign(window,{gapi:{load:vi.fn()},google:{accounts:{oauth2:{initTokenClient:(value:Record<string,unknown>)=>{consent=value;return {requestAccessToken:vi.fn()};}}},picker:{PickerBuilder:Builder,DocsView:class{setMode(){return this;}},DocsViewMode:{LIST:'list'}}}});
});
afterEach(()=>{delete (window as unknown as {google?:unknown}).google;delete (window as unknown as {gapi?:unknown}).gapi;});
const token=(scope='https://www.googleapis.com/auth/drive.file')=>(consent.callback as (data:unknown)=>void)({access_token:'ephemeral-token',scope});
it('GIS limita scopes, token solo memoria y cancela/destruye al elegir',async()=>{
  const operation=openGooglePicker(config,new AbortController().signal);await vi.waitFor(()=>expect(consent.callback).toBeTypeOf('function'));
  expect(consent).toMatchObject({scope:'https://www.googleapis.com/auth/drive.file',include_granted_scopes:false});token();expect(setOAuthToken).toHaveBeenCalledWith('ephemeral-token');callback({action:'picked',docs:[{id:'file_one'}]});expect(await operation).toBe('file_one');expect(dispose).toHaveBeenCalledTimes(1);expect(sessionStorage.length+localStorage.length).toBe(0);
});
it('token compuesto Calendar/Gmail se rechaza antes de llegar a Picker',async()=>{
  const operation=openGooglePicker(config,new AbortController().signal);const failed=expect(operation).rejects.toThrow();await Promise.resolve();await Promise.resolve();token('https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.freebusy');await failed;expect(setOAuthToken).not.toHaveBeenCalled();
});
it('cambiar contexto descarta callback GIS tardío y no abre el selector',async()=>{
  const abort=new AbortController();const operation=openGooglePicker(config,abort.signal);await Promise.resolve();await Promise.resolve();abort.abort();token();expect(await operation).toBeNull();expect(setOAuthToken).not.toHaveBeenCalled();
});
it('cancelar Picker descarta selección sin mutar backend',async()=>{
  const operation=openGooglePicker(config,new AbortController().signal);await Promise.resolve();await Promise.resolve();token();callback({action:'cancel'});expect(await operation).toBeNull();expect(dispose).toHaveBeenCalledTimes(1);
});
