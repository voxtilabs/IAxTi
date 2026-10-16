/** El token GIS solo tiene drive.file. Nunca recibe el token compuesto del servidor. */
const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.file';
interface Picker {setVisible(value:boolean):void;dispose():void}
interface Builder {addView(view:unknown):Builder;setOAuthToken(token:string):Builder;setDeveloperKey(key:string):Builder;setAppId(id:string):Builder;setOrigin(origin:string):Builder;setCallback(fn:(data:{action:string;docs?:Array<{id:string}>})=>void):Builder;build():Picker}
interface GoogleBrowser {
  accounts:{oauth2:{initTokenClient(config:{client_id:string;scope:string;include_granted_scopes:boolean;callback:(result:{access_token?:string;scope?:string;error?:string})=>void;error_callback:()=>void}):{requestAccessToken(options:{prompt:string}):void}}};
  picker:{PickerBuilder:new()=>Builder;DocsView:new()=>{setMode(mode:unknown):unknown};DocsViewMode:{LIST:unknown}};
}
interface PickerWindow extends Window {google?:GoogleBrowser;gapi?:{load(name:string,options:{callback:()=>void;onerror:()=>void;timeout:number;ontimeout:()=>void}):void}}
let loading:Promise<void>|null=null;
function script(src:string){return new Promise<void>((resolve,reject)=>{
  const node=document.createElement('script');node.src=src;node.async=true;node.referrerPolicy='no-referrer';
  const timer=setTimeout(()=>{node.remove();reject(new Error('Google no respondió. Intenta abrir el selector otra vez.'));},12000);
  node.onload=()=>{clearTimeout(timer);resolve();};node.onerror=()=>{clearTimeout(timer);node.remove();reject(new Error('No pudimos cargar el selector de Google. Revisa la conexión e intenta otra vez.'));};document.head.append(node);
});}
async function ready(){
  const browser=window as PickerWindow;
  loading??=(async()=>{
    if(!browser.google?.accounts)await script('https://accounts.google.com/gsi/client');
    if(!browser.gapi)await script('https://apis.google.com/js/api.js');
    if(!browser.google?.picker)await new Promise<void>((resolve,reject)=>browser.gapi!.load('picker',{callback:resolve,onerror:()=>reject(new Error('No pudimos abrir Google Drive. Intenta otra vez.')),timeout:12000,ontimeout:()=>reject(new Error('Google Drive no respondió. Intenta otra vez.'))}));
  })().catch(error=>{loading=null;throw error;});
  await loading;if(!browser.google)throw new Error('No pudimos abrir Google Drive.');return browser.google;
}
export async function prepareGooglePicker():Promise<void>{await ready();}
export async function openGooglePicker(config:{clientId:string;apiKey:string;appId:string},signal:AbortSignal):Promise<string|null>{
  const google=await ready();if(signal.aborted)return null;
  return new Promise((resolve,reject)=>{
    let picker:Picker|null=null;let settled=false;
    const finish=(fileId:string|null,error?:Error)=>{if(settled)return;settled=true;signal.removeEventListener('abort',cancel);picker?.setVisible(false);picker?.dispose();picker=null;if(error)reject(error);else resolve(fileId);};
    const cancel=()=>finish(null);signal.addEventListener('abort',cancel,{once:true});
    const fail=()=>finish(null,new Error('No pudimos abrir tu selección de Drive. Revisa el permiso e intenta otra vez.'));
    const client=google.accounts.oauth2.initTokenClient({client_id:config.clientId,scope:DRIVE_SCOPE,include_granted_scopes:false,error_callback:fail,callback:response=>{
      if(settled||signal.aborted)return;
      const scopes=response.scope?.split(/\s+/).filter(Boolean)??[];
      // Un permiso combinado nunca llega al iframe del selector.
      if(response.error||!response.access_token||response.access_token.length>16384||scopes.length!==1||scopes[0]!==DRIVE_SCOPE){fail();return;}
      let token=response.access_token;response.access_token=undefined;
      try{
        const view=new google.picker.DocsView().setMode(google.picker.DocsViewMode.LIST);
        picker=new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(config.apiKey).setAppId(config.appId).setOrigin(window.location.origin).setCallback(data=>{
          if(data.action==='cancel')finish(null);
          else if(data.action==='picked'){const id=data.docs?.[0]?.id;if(!id||! /^[A-Za-z0-9_-]{1,200}$/.test(id)){fail();return;}finish(id);}
        }).build();picker.setVisible(true);
      }catch{fail();}finally{token='';}
    }});
    try{client.requestAccessToken({prompt:'select_account'});}catch{fail();}
  });
}
