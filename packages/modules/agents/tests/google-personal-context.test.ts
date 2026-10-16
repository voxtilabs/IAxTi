import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {runMigrations,withTenant} from '@iaxti/db';
const traces=vi.hoisted(()=>({trace:vi.fn()}));
vi.mock('../application/langfuse',async original=>({...await original<object>(),traceGeneration:traces.trace}));
import {conversarConElAgenteGeneral} from '../application/agente-general';
import {CATALOGO} from '../application/catalogo';
import type {ModelPort} from '../application/models';
let pool:Pool;let tenantId:string;
const personalTool=CATALOGO.some(h=>h.nombre==='gmail.get_threads')?'gmail.get_threads':'drive.search';
const personalArgs=personalTool==='gmail.get_threads'?{contactId:'11111111-1111-4111-8111-111111111111'}:{query:'correo privado',readDocuments:true};
const PRIVATE='PRIVATE-MAIL-SNIPPET-NEVER-IN-LOGS';
const permissions=new Set(CATALOGO.map(h=>h.permiso).filter((p):p is string=>Boolean(p)));
const modules=new Set(CATALOGO.map(h=>h.modulo).filter((p):p is string=>Boolean(p)));
beforeAll(async()=>{pool=new Pool({connectionString:process.env.DATABASE_URL});await runMigrations(pool);tenantId=(await pool.query("INSERT INTO tenants(name,plan,state) VALUES('gmail-agent-privacy','crece','active') RETURNING id")).rows[0].id;});
afterAll(async()=>pool?.end());
async function run(modelo:ModelPort,contextoPersonal=false,last='Consulta mi correo'){
  return withTenant(pool,tenantId,c=>conversarConElAgenteGeneral(c,{tenantId,turnos:[{role:'user',content:last}],contextoPersonal,permisos:permissions,modulosActivos:modules,actorUserId:'personal-user'},
    {modelo,provider:'openai',model:'gpt-5',llamarApi:async()=>({ok:true,estado:200,datos:{threads:[{subject:PRIVATE,snippet:PRIVATE}]}})}));
}
const copy=(fail=false):ModelPort=>({async generate(input){const prepare=input.tools!.find(t=>t.name==='preparar_accion')!;const result=await prepare.ejecutar({herramienta:personalTool,argumentos:personalArgs});expect(JSON.stringify(result)).toContain(PRIVATE);if(fail)throw new Error(PRIVATE);return{text:PRIVATE,tokensIn:10,tokensOut:10};}});
describe('contenido Google personal fuera de corridas y trazas del negocio',()=>{
  it('el modelo puede responder a la persona pero no persistir el extracto en DB/Langfuse',async()=>{const result=await run(copy());expect(result.texto).toBe(PRIVATE);expect(result.contextoPersonal).toBe(true);
    const row=(await pool.query('SELECT input,output,explanation,error FROM agent_executions WHERE id=$1',[result.executionId])).rows[0];expect(JSON.stringify(row)).not.toContain(PRIVATE);expect(row.output.pasos).toContain(personalTool);expect(JSON.stringify(traces.trace.mock.calls)).not.toContain(PRIVATE);});
  it('un followup que cita correo conserva supresión aunque no invoque otra tool',async()=>{const result=await run({generate:async()=>({text:`Respuesta con ${PRIVATE}`,tokensIn:10,tokensOut:10})},true,`El correo dice ${PRIVATE}`);expect(result.contextoPersonal).toBe(true);const row=(await pool.query('SELECT input,output FROM agent_executions WHERE id=$1',[result.executionId])).rows[0];expect(JSON.stringify(row)).not.toContain(PRIVATE);expect(JSON.stringify(traces.trace.mock.calls)).not.toContain(PRIVATE);});
  it('un fallo después de leer conserva pasos/métricas sin error ni texto personal',async()=>{const result=await run(copy(true));expect(result.status).toBe('failed');expect(result.contextoPersonal).toBe(true);const row=(await pool.query('SELECT input,output,error,explanation FROM agent_executions WHERE id=$1',[result.executionId])).rows[0];expect(JSON.stringify(row)).not.toContain(PRIVATE);expect(row.output.pasos).toContain(personalTool);});
  it('redacta PII de resultados/followups personales antes del modelo, conservando IDs opacos',async()=>{
    const email='privada@example.test',phone='+56912345678',opaque='123456789012345';
    await withTenant(pool,tenantId,c=>conversarConElAgenteGeneral(c,{tenantId,contextoPersonal:true,turnos:[{role:'user',content:`Ese correo dice ${email} ${phone}`}],permisos:permissions,modulosActivos:modules},{provider:'openai',model:'gpt-5',llamarApi:async()=>({ok:true,estado:200,datos:{threads:[{id:opaque,subject:email,snippet:phone}]}}),modelo:{async generate(input){expect(JSON.stringify(input.mensajes)).not.toMatch(/privada@example.test|56912345678/);const result=await input.tools!.find(t=>t.name==='preparar_accion')!.ejecutar({herramienta:personalTool,argumentos:personalArgs});expect(JSON.stringify(result)).not.toMatch(/privada@example.test|56912345678/);expect(JSON.stringify(result)).toContain(opaque);expect(JSON.stringify(result)).toContain('[correo]');return{text:'Respuesta segura',tokensIn:1,tokensOut:1};}}}));
  });
  it('política explícita sin redacción conserva contenido hacia modelo pero nunca hacia trazas/DB',async()=>{
    await pool.query("UPDATE tenants SET settings=jsonb_set(COALESCE(settings,'{}'::jsonb),'{ia}','{\"redactPII\":false}'::jsonb) WHERE id=$1",[tenantId]);
    try{const result=await withTenant(pool,tenantId,c=>conversarConElAgenteGeneral(c,{tenantId,contextoPersonal:true,turnos:[{role:'user',content:'privada@example.test'}],permisos:permissions,modulosActivos:modules},{provider:'openai',model:'gpt-5',llamarApi:async()=>({ok:true,estado:200,datos:{snippet:'privada@example.test'}}),modelo:{async generate(input){expect(input.mensajes![0].content).toBe('privada@example.test');const r=await input.tools!.find(t=>t.name==='preparar_accion')!.ejecutar({herramienta:personalTool,argumentos:personalArgs});expect(JSON.stringify(r)).toContain('privada@example.test');return{text:'privada@example.test',tokensIn:1,tokensOut:1};}}}));expect(JSON.stringify((await pool.query('SELECT input,output FROM agent_executions WHERE id=$1',[result.executionId])).rows)).not.toContain('privada@example.test');expect(JSON.stringify(traces.trace.mock.calls)).not.toContain('privada@example.test');}finally{await pool.query("UPDATE tenants SET settings=settings-'ia' WHERE id=$1",[tenantId]);}
  });
  it('contextoPersonal no otorga permisos: sin read no consulta correo',async()=>{let called=false;const result=await withTenant(pool,tenantId,c=>conversarConElAgenteGeneral(c,{tenantId,contextoPersonal:true,turnos:[{role:'user',content:'Pregunta'}],permisos:new Set(),modulosActivos:modules},{modelo:{async generate(input){const r=await input.tools!.find(t=>t.name==='preparar_accion')!.ejecutar({herramienta:personalTool,argumentos:personalArgs});expect(r).toMatchObject({error:expect.any(String)});return{text:'Sin permiso',tokensIn:1,tokensOut:1};}},provider:'openai',model:'gpt-5',llamarApi:async()=>{called=true;return{ok:true,estado:200,datos:{}};}}));expect(called).toBe(false);expect(result.contextoPersonal).toBe(true);});
});
