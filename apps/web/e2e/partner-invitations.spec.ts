import {expect,test,type Page,type Locator} from '@playwright/test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const auth=JSON.parse(readFileSync(join(__dirname,'.partner-auth.json'),'utf8')) as Array<{mode:string;tenantId:string;userId:string;accessToken:string}>;
const destination=join(__dirname,'../../../docs/evidencias/56-partner');
const measurements:unknown[]=[];
test.afterAll(()=>{mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'medidas.json'),JSON.stringify(measurements,null,2)+'\n');});
async function keyboard(page:Page,target:Locator){
 for(let i=0;i<100&&!(await target.evaluate(el=>el===document.activeElement));i++)await page.keyboard.press('Tab');
 await expect(target).toBeFocused();await expect(target).toHaveCSS('outline-style','solid');
 const measured=await target.evaluate(el=>{
  const r=document.createRange();r.selectNodeContents(el);const t=r.getBoundingClientRect(),b=el.getBoundingClientRect();
  return {text:el.textContent,mode:document.documentElement.dataset.mode,viewport:innerWidth,tag:el.tagName,
   control:{width:b.width,height:b.height},textHeight:t.height,outline:getComputedStyle(el).outlineStyle,
   fits:t.top>=b.top&&t.bottom<=b.bottom&&t.left>=b.left&&t.right<=b.right};
 });
 measurements.push(measured);expect(measured.fits,JSON.stringify(measured)).toBe(true);
 if(measured.tag==='BUTTON')expect(measured.control.height).toBeGreaterThanOrEqual(46);
}

for(const mode of ['dia','noche','recuperacion'])test(`invitación durable, callback y custodia ${mode} a 360`,async({page,request})=>{
 const a=auth.find(x=>x.mode===mode)!;mkdirSync(destination,{recursive:true});
 const session={access_token:a.accessToken,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'e2e',user:{id:a.userId,aud:'authenticated',email:'ficticio@example.test'}};
 await page.addInitScript(({session,tenant,mode})=>{localStorage.setItem('sb-127-auth-token',JSON.stringify(session));localStorage.setItem('iaxti-tenant',tenant);localStorage.setItem('pulso-mode',mode==='noche'?'noche':'dia');},{session,tenant:a.tenantId,mode});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');const panel=page.getByRole('region',{name:'Conexión de WhatsApp',exact:true});
 const start=panel.getByRole('button',{name:'Conectar WhatsApp',exact:true});await expect(start).toBeVisible();await keyboard(page,start);
 await panel.screenshot({path:join(destination,`partner-${mode}-360-inicio.png`)});
 const before=await (await request.get('http://127.0.0.1:4073/fixture/counts')).json();await page.keyboard.press('Enter');
 const link=panel.getByRole('link',{name:'Continuar con Facebook'});await expect(link).toBeVisible();const href=(await link.getAttribute('href'))!;
 expect(href).toMatch(/^https:\/\/dashboard.zavu.dev\/invite\/inv_/);await expect(link).toHaveAttribute('referrerpolicy','no-referrer');await keyboard(page,link);
 await panel.screenshot({path:join(destination,`partner-${mode}-360-enlace.png`)});
 await page.reload();await expect(link).toHaveAttribute('href',href);expect((await (await request.get('http://127.0.0.1:4073/fixture/counts')).json()).created-before.created).toBe(1);
 const callback=await request.post('http://127.0.0.1:4073/fixture/complete',{data:{invitationId:href.split('/').at(-1),failRotation:mode==='recuperacion'}});expect(await callback.json()).toEqual({status:204});
 if(mode==='recuperacion'){
  await expect(panel.getByText(/canal sigue sin activarse/)).toBeVisible();const retry=panel.getByRole('button',{name:'Reintentar conexión segura'});await keyboard(page,retry);await panel.screenshot({path:join(destination,'partner-recuperacion-360-pendiente.png')});await page.keyboard.press('Enter');
 }
 await expect(panel.getByText(/WhatsApp está conectado/)).toBeVisible();await panel.screenshot({path:join(destination,`partner-${mode}-360-activo.png`)});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 await page.reload();await expect(page.getByRole('region',{name:'Puesta en marcha de tu negocio'})).toBeVisible();await expect(panel).toHaveCount(0);
});
