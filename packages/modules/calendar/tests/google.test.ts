import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { runMigrations, withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { GOOGLE_CALENDAR_SCOPE, GoogleIntegrationError } from '@iaxti/google';
import { definirDisponibilidad } from '../application/agenda';
import {
  iniciarGoogleCalendar, completarGoogleCalendar, estadoGoogleCalendar, huecosConGoogle,
  autenticarPushGoogle, procesarPushGoogle, renovarWatchGoogle, mantenerWatchesGoogle, revocarGoogleCalendar, limpiarSecretosGoogle,
} from '../application/google';
import type { CalendarGoogleDeps } from '../application/google-config';

const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const role = `google_test_${randomBytes(6).toString('hex')}`;
const instant = new Date('2027-02-25T12:00:00Z');
let admin: Pool; let app: Pool; let tenantId: string; let userId: string; let other: string;
let deps: CalendarGoogleDeps; let versions: Map<string,string>;
let revision = 0;

const AUDIT_INEXISTENTE = 'audit_log_que_no_existe';
const COLUMNAS_DE_LA_INTENCION = '(tenant_id,user_id,secret_ref,destroy_pending,whole_secret)';

/**
 * Un pool que reescribe el TEXTO de ciertas consultas de ESTA conexión (#910).
 *
 * Las dos pruebas de abajo necesitaban que algo pasara dentro de una
 * transacción ajena —que una escritura falle, que una fila nazca vieja— y las
 * dos lo conseguían creando un trigger en el esquema COMPARTIDO y borrándolo en
 * un `finally`. El `finally` no corre si el proceso muere en el medio —Ctrl-C,
 * OOM, el timeout de la suite—, así que el trigger se quedaba en la base para
 * siempre; y mientras existía, lo veían los sesenta y pico de archivos que
 * vitest corre en paralelo contra esta misma base.
 *
 * Reescribir el texto de la consulta de esta conexión consigue lo mismo sin
 * tocar el catálogo, y es el patrón que manda la guarda de
 * `core/tests/las-pruebas-no-dejan-basura.test.ts`. Los ejemplos que ya estaban:
 * `payments/tests/aviso-de-pago.test.ts` y `workers/tests/outbound-vigencia.test.ts`.
 *
 * Va sobre el POOL y no sobre el cliente, a diferencia de esos dos, porque
 * `completarGoogleCalendar` y `revocarGoogleCalendar` reciben un pool y abren su
 * `withTenant` adentro: no hay dónde pasarles un cliente.
 *
 * `reescribir` devuelve `null` para dejar la consulta como está.
 */
function poolQueReescribe(pool: Pool, reescribir: (sql: string, valores: unknown) => string | null): Pool {
  const envolver = (cliente: PoolClient): PoolClient => new Proxy(cliente, {
    get(destino, prop, receptor) {
      if (prop !== 'query') {
        const valor = Reflect.get(destino, prop, receptor);
        return typeof valor === 'function' ? valor.bind(destino) : valor;
      }
      const consultar = destino.query.bind(destino) as unknown as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const [texto, ...rest] = args;
        if (typeof texto === 'string') return consultar(reescribir(texto, rest[0]) ?? texto, ...rest);
        const config = texto as { text?: unknown; values?: unknown } | null;
        if (config && typeof config.text === 'string') {
          const cambiado = reescribir(config.text, config.values);
          if (cambiado) return consultar({ ...config, text: cambiado }, ...rest);
        }
        return consultar(texto, ...rest);
      };
    },
  });
  return new Proxy(pool, {
    get(destino, prop, receptor) {
      if (prop !== 'connect') {
        const valor = Reflect.get(destino, prop, receptor);
        return typeof valor === 'function' ? valor.bind(destino) : valor;
      }
      return async () => envolver(await destino.connect());
    },
  });
}

/**
 * Desvía SOLO el INSERT de la acción pedida.
 *
 * `writeAudit` consulta `audit_log` también para encadenar el hash anterior, y
 * el nombre de la tabla viaja en el texto de las dos consultas: desviar
 * cualquiera haría fallar la primera que pase, y la prueba dejaría de hablar
 * del revoke para hablar de «algo de la auditoría».
 *
 * El error lo sigue poniendo Postgres, así que la transacción se aborta de
 * verdad —que es la mitad de lo que la prueba mira—. Ojo con lo que llega
 * arriba: lo que se ve no es `relation … does not exist` sino el
 * `current transaction is aborted` de la consulta siguiente de esa misma
 * transacción. Por eso la prueba no fija el mensaje: fija que la fila de
 * auditoría NO quedó, que es el invariante.
 */
const desviarElAuditDe = (accion: string) => (sql: string, valores: unknown) =>
  // El `\b` del final deja fuera el nombre ya desviado: `_` es carácter de
  // palabra, así que `audit_log_que_no_existe` no vuelve a calzar.
  Array.isArray(valores) && valores.includes(accion) ? sql.replace(/\baudit_log\b/g, AUDIT_INEXISTENTE) : null;

/**
 * Hace nacer vieja la fila de intención, como el trigger `BEFORE INSERT` que
 * reemplaza: le pone `created_at` explícito en el INSERT de
 * `reservarSecretoGoogle`, que hoy la deja en el `now()` por defecto.
 *
 * No se puede hacer con un `UPDATE` de afuera —fue lo primero que probé y se
 * cuelga—: `bloquearIntentoSecretoGoogle` toma la fila con `SELECT … FOR UPDATE`
 * dentro de la transacción que la prueba mantiene retenida, así que cualquier
 * escritura externa espera ese lock hasta el timeout.
 *
 * Lleva contador porque esto se acopla al TEXTO del INSERT. Si ese texto cambia,
 * la prueba tiene que ponerse roja diciendo eso, y no quedarse verde habiendo
 * dejado de envejecer nada.
 */
function envejecerLaIntencion(minutos: number) {
  const veces = { reescritas: 0 };
  const reescribir = (sql: string) => {
    if (!sql.includes(COLUMNAS_DE_LA_INTENCION)) return null;
    veces.reescritas++;
    return sql
      .replace(COLUMNAS_DE_LA_INTENCION, COLUMNAS_DE_LA_INTENCION.replace(')', ',created_at)'))
      .replace('VALUES($1,$2,$3,true,true)', `VALUES($1,$2,$3,true,true,now()-interval '${minutos} minutes')`);
  };
  return { reescribir, veces };
}

beforeAll(async () => {
  admin = new Pool({ connectionString:url });
  await runMigrations(admin);
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS NOSUPERUSER`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  app = new Pool({connectionString:url,options:`-c role=${role}`,max:12});
});
afterAll(async()=>{
  await app?.end();
  if(admin){await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);await admin.end();}
});
beforeEach(async()=>{
  tenantId=(await admin.query("INSERT INTO tenants(name,timezone) VALUES('google-test','America/Santiago') RETURNING id")).rows[0].id;
  other=(await admin.query("INSERT INTO tenants(name,timezone) VALUES('otro-google','America/Santiago') RETURNING id")).rows[0].id;
  userId=randomUUID(); versions=new Map(); revision=0;
  const save=async(id:string,payload:string)=>{const ref=`projects/iaxti-test/secrets/${id}/versions/${++revision}`;versions.set(ref,payload);return ref;};
  deps={clientId:'test-client',webhookAddress:'https://api.example.test/webhooks/google/calendar',ahora:()=>instant,
    oauth:{authorizationUrl:vi.fn(()=> 'https://accounts.google.com/o/oauth2/v2/auth'),
      exchange:vi.fn(async()=>({accessToken:'secret-access',refreshToken:'secret-refresh',expiresIn:3600,scope:['openid',GOOGLE_CALENDAR_SCOPE],idToken:'signed-id-token'})),
      verifyIdToken:vi.fn(async()=>({sub:`google-${userId}`})),refresh:vi.fn(async()=>({accessToken:'refreshed-access',expiresIn:3600,scope:[GOOGLE_CALENDAR_SCOPE]})),revoke:vi.fn(async()=>{})},
    secrets:{put:vi.fn(save),addVersion:vi.fn(save),access:vi.fn(async(ref)=>{const v=versions.get(ref);if(!v)throw new Error('missing');return v;}),destroy:vi.fn(async ref=>{versions.delete(ref);}),deleteSecret:vi.fn(async id=>{for(const key of versions.keys())if(key.includes(`/secrets/${id}/`))versions.delete(key);})},
    calendar:{freebusy:vi.fn(async()=>({primary:[]})),watch:vi.fn(async i=>({id:i.channelId,resourceId:'resource-opaque',expiration:Date.now()+86_400_000*365})),stop:vi.fn(async()=>{})}};
});

async function attempt(t=tenantId,u=userId){
  await admin.query("INSERT INTO user_roles(tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE name='USER' AND tenant_id IS NULL ON CONFLICT DO NOTHING",[t,u]);
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const start=await iniciarGoogleCalendar(app,{tenantId:t,userId:u,challenge},deps);
  return {tenantId:t,userId:u,state:start.state,nonce:start.nonce,verifier,code:'temporary-code'};
}
async function connect(t=tenantId,u=userId,pool: Pool=app){return completarGoogleCalendar(pool,await attempt(t,u),deps);}
async function availability(){await withTenant(app,tenantId,c=>definirDisponibilidad(c,{tenantId,ownerId:userId,weekday:1,inicioMin:540,finMin:720,duracion:30,respiro:15,anticipacionMin:0}));}
const slots=()=>huecosConGoogle(app,{tenantId,ownerId:userId,dia:'2027-03-01',ahora:instant},deps);

describe('consentimiento personal y custodia',()=>{
  it('ejecuta bajo un rol real sin bypass y guarda solo hashes/referencias',async()=>{
    expect((await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    const data=await attempt(); const status=await completarGoogleCalendar(app,data,deps);
    expect(status.status).toBe('active'); expect(status.pushActive).toBe(true);
    const attemptRow=(await admin.query('SELECT * FROM google_oauth_attempts WHERE tenant_id=$1',[tenantId])).rows[0];
    const grant=(await admin.query('SELECT * FROM google_oauth_grants WHERE tenant_id=$1',[tenantId])).rows[0];
    const serialized=JSON.stringify([attemptRow,grant,status]);
    for(const secret of [data.verifier,data.state,data.nonce,data.code,'secret-access','secret-refresh','signed-id-token'])expect(serialized).not.toContain(secret);
    expect(deps.oauth.authorizationUrl).toHaveBeenCalledWith(expect.objectContaining({scopes:['openid',GOOGLE_CALENDAR_SCOPE]}));
    expect((await withTenant(app,other,c=>c.query('SELECT * FROM google_oauth_grants'))).rowCount).toBe(0);
    expect((await app.query('SELECT * FROM google_oauth_grants')).rowCount).toBe(0);
  });
  it.each(['state','verifier','nonce'] as const)('rechaza %s incorrecto sin intercambiar el código',async field=>{
    const data=await attempt();data[field]=randomBytes(32).toString('base64url');
    await expect(completarGoogleCalendar(app,data,deps)).rejects.toThrow(/expiró/);
    expect(deps.oauth.exchange).not.toHaveBeenCalled();
  });
  it('rechaza otro usuario/tenant y un intento vencido',async()=>{
    const data=await attempt();
    await expect(completarGoogleCalendar(app,{...data,userId:randomUUID()},deps)).rejects.toThrow();
    await expect(completarGoogleCalendar(app,{...data,tenantId:other},deps)).rejects.toThrow();
    await admin.query('UPDATE google_oauth_attempts SET expires_at=$2 WHERE tenant_id=$1',[tenantId,instant]);
    await expect(completarGoogleCalendar(app,data,deps)).rejects.toThrow();
    expect(deps.oauth.exchange).not.toHaveBeenCalled();
  });
  it('dos callbacks simultáneos intercambian un código una sola vez',async()=>{
    const data=await attempt();const results=await Promise.allSettled([completarGoogleCalendar(app,data,deps),completarGoogleCalendar(app,data,deps)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(deps.oauth.exchange).toHaveBeenCalledTimes(1);
  });
  it('un fallo de Google deja consumido el intento y registra el rechazo',async()=>{
    vi.mocked(deps.oauth.exchange).mockRejectedValue(new GoogleIntegrationError('GOOGLE_INVALID_GRANT',400));
    const data=await attempt();await expect(completarGoogleCalendar(app,data,deps)).rejects.toThrow();
    await expect(completarGoogleCalendar(app,data,deps)).rejects.toThrow(/expiró/);
    expect(deps.oauth.exchange).toHaveBeenCalledTimes(1);
    expect((await admin.query("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='google.consent.failed' AND result='error'",[tenantId])).rowCount).toBe(1);
  });
  it('un permiso parcial o ID token inválido no crea conexión',async()=>{
    vi.mocked(deps.oauth.exchange).mockResolvedValueOnce({accessToken:'secret-access',refreshToken:'secret-refresh',expiresIn:3600,scope:['openid'],idToken:'signed-id-token'});
    await expect(connect()).rejects.toThrow();expect(deps.secrets.put).not.toHaveBeenCalled();
    vi.mocked(deps.oauth.verifyIdToken).mockRejectedValueOnce(new Error('bad signature'));
    await expect(connect()).rejects.toThrow();expect((await estadoGoogleCalendar(app,{tenantId,userId},deps)).status).toBe('disconnected');
  });
  it('reauthoriza la misma identidad sin perder refresh_token y bloquea cambios silenciosos',async()=>{
    await connect();vi.mocked(deps.oauth.exchange).mockResolvedValue({accessToken:'second-access',expiresIn:3600,scope:['openid',GOOGLE_CALENDAR_SCOPE],idToken:'another-id-token'});
    await connect();expect([...versions.values()].some(s=>s.includes('second-access')&&s.includes('secret-refresh'))).toBe(true);
    vi.mocked(deps.oauth.verifyIdToken).mockResolvedValue({sub:'another-person'});
    await expect(connect()).rejects.toThrow();
    const grant=(await admin.query('SELECT google_subject FROM google_oauth_grants WHERE tenant_id=$1',[tenantId])).rows[0];
    expect(grant.google_subject).toBe(`google-${userId}`);
  });
  it('el recolector gana antes del callback: no recrea un secreto sin intención',async()=>{
    const data=await attempt();const blocker=await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`google-user:${tenantId}:${userId}`]);
    const pending=completarGoogleCalendar(app,data,deps).then(()=>null,error=>error);
    try {
      await vi.waitFor(async()=>expect((await admin.query('SELECT 1 FROM google_secret_versions WHERE tenant_id=$1 AND whole_secret',[tenantId])).rowCount).toBe(1));
      await admin.query("UPDATE google_secret_versions SET created_at=now()-interval '16 minutes' WHERE tenant_id=$1",[tenantId]);
      await limpiarSecretosGoogle(app,deps);
      await blocker.query('COMMIT');
      expect(await pending).toBeInstanceOf(Error);
      expect(deps.secrets.put).not.toHaveBeenCalled();
      expect((await estadoGoogleCalendar(app,{tenantId,userId},deps)).status).toBe('disconnected');
    } finally {await blocker.query('ROLLBACK');blocker.release();}
  });
  it('una creación en curso conserva su intención aunque el recolector la vea antigua',async()=>{
    let entered!:()=>void;let release!:()=>void;
    const began=new Promise<void>(resolve=>{entered=resolve;});const hold=new Promise<void>(resolve=>{release=resolve;});
    const original=deps.secrets.put;
    vi.mocked(deps.secrets.put).mockImplementationOnce(async(id,payload)=>{
      const ref=`projects/iaxti-test/secrets/${id}/versions/1`;versions.set(ref,payload);entered();await hold;return ref;
    });
    const vieja=envejecerLaIntencion(16);
    const pending=connect(tenantId,userId,poolQueReescribe(app,vieja.reescribir));
    try {
      await began;
      expect(vieja.veces.reescritas).toBe(1);
      // Que la fila sea CANDIDATA del recolector es la premisa de esta prueba, y
      // sin ella pasa por la razón equivocada: si nace joven, el barrido ni la
      // mira —filtra `created_at<now()-interval '15 minutes'`— y la intención
      // sobrevive sola. Lo encontré con la mordida: con el envejecimiento en
      // cero, el caso seguía verde. Se lee desde `admin` porque la fila ya está
      // committeada y un SELECT no espera el `FOR UPDATE` de la otra transacción.
      expect((await admin.query(
        "SELECT 1 FROM google_secret_versions WHERE tenant_id=$1 AND whole_secret AND created_at<now()-interval '15 minutes'",
        [tenantId])).rowCount).toBe(1);
      await limpiarSecretosGoogle(app,deps);
      expect(versions.size).toBe(1);
      expect((await admin.query('SELECT 1 FROM google_secret_versions WHERE tenant_id=$1 AND whole_secret',[tenantId])).rowCount).toBe(1);
      release();expect((await pending).status).toBe('active');
      expect((await admin.query('SELECT 1 FROM google_secret_versions WHERE tenant_id=$1 AND whole_secret',[tenantId])).rowCount).toBe(0);
    } finally {release();await pending.catch(()=>{});deps.secrets.put=original;}
  });
  it('un timeout de creación deja intención durable aunque no devuelva referencia',async()=>{
    vi.mocked(deps.secrets.put).mockImplementationOnce(async(id,payload)=>{
      versions.set(`projects/iaxti-test/secrets/${id}/versions/1`,payload);
      throw new GoogleIntegrationError('GOOGLE_TIMEOUT');
    });
    await expect(connect()).rejects.toThrow();
    expect(versions.size).toBe(1);
    const row=(await admin.query('SELECT secret_ref FROM google_secret_versions WHERE tenant_id=$1 AND whole_secret',[tenantId])).rows[0];
    expect(row.secret_ref).toMatch(/^iaxti-google-/);
    await admin.query("UPDATE google_secret_versions SET created_at=now()-interval '16 minutes' WHERE tenant_id=$1",[tenantId]);
    await limpiarSecretosGoogle(app,deps);
    expect(deps.secrets.deleteSecret).toHaveBeenCalledWith(row.secret_ref);
    expect(versions.size).toBe(0);
  });
});

describe('horarios de Google y notificaciones',()=>{
  it('mantiene agenda local sin cuenta conectada, aunque el proveedor no esté configurado',async()=>{
    await availability();expect(await huecosConGoogle(app,{tenantId,ownerId:userId,dia:'2027-03-01',ahora:instant},null)).toHaveLength(4);
  });
  it('el copiloto reutiliza su cliente y cerrojo de auditoría incluso con pool de una conexión',async()=>{
    await connect();await availability();
    const single=new Pool({connectionString:url,options:`-c role=${role}`,max:1});
    try {
      const result=await withTenant(single,tenantId,async c=>{
        await writeAudit(c,{tenantId,actor:userId,actorKind:'agent',action:'agent.tool.previous',resource:'tenant',result:'ok'});
        return huecosConGoogle(c,{tenantId,ownerId:userId,dia:'2027-03-01',ahora:instant},deps);
      });
      expect(result).toHaveLength(4);expect(deps.calendar.freebusy).toHaveBeenCalledTimes(1);
      expect((await admin.query("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='google.calendar.freebusy'",[tenantId])).rowCount).toBe(1);
    } finally {await single.end();}
  });
  it('resta ocupación real y buffer de la disponibilidad configurada',async()=>{
    await connect();await availability();
    vi.mocked(deps.calendar.freebusy).mockResolvedValue({primary:[{start:'2027-03-01T12:40:00Z',end:'2027-03-01T13:00:00Z'}]});
    expect((await slots()).map(s=>s.hora)).toEqual(['10:30','11:15']);
    expect(deps.calendar.freebusy).toHaveBeenCalledWith(expect.objectContaining({timeMin:'2027-03-01T02:45:00.000Z',timeMax:'2027-03-02T03:15:00.000Z',timeZone:'America/Santiago'}));
  });
  it('editar un buffer espera la lectura en curso y obliga a consultar los nuevos límites',async()=>{
    await connect();await availability();
    let entered!:()=>void;let release!:()=>void;
    const began=new Promise<void>(resolve=>{entered=resolve;});const hold=new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(deps.calendar.freebusy).mockImplementationOnce(async()=>{entered();await hold;return {primary:[]};});
    const reading=slots();await began;
    const editing=withTenant(app,tenantId,c=>definirDisponibilidad(c,{tenantId,ownerId:userId,weekday:1,inicioMin:0,finMin:60,duracion:30,respiro:30,anticipacionMin:0}));
    // Esperamos evidencia del cerrojo, no un retraso arbitrario.
    try {
      await vi.waitFor(async()=>expect((await admin.query(`SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'`)).rowCount).toBeGreaterThan(0));
    } finally {release();}
    expect((await reading).map(x=>x.hora)).not.toContain('00:00');await editing;
    vi.mocked(deps.calendar.freebusy).mockResolvedValue({primary:[{start:'2027-03-01T02:40:00Z',end:'2027-03-01T02:55:00Z'}]});
    expect((await slots()).map(x=>x.hora)).not.toContain('00:00');
    expect(deps.calendar.freebusy).toHaveBeenLastCalledWith(expect.objectContaining({timeMin:'2027-03-01T02:30:00.000Z'}));
  });
  it('una reunión del día anterior sigue ocupando la mañana',async()=>{
    await connect();await availability();vi.mocked(deps.calendar.freebusy).mockResolvedValue({primary:[{start:'2027-02-28T23:00:00Z',end:'2027-03-01T13:00:00Z'}]});
    expect((await slots()).map(s=>s.hora)).toEqual(['10:30','11:15']);
  });
  it('un fallo externo no se convierte en huecos libres y deja auditoría',async()=>{
    await connect();await availability();vi.mocked(deps.calendar.freebusy).mockRejectedValue(new GoogleIntegrationError('GOOGLE_FREEBUSY_UNAVAILABLE'));
    await expect(slots()).rejects.toThrow(/No pudimos comprobar/);
    expect((await admin.query("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='google.calendar.freebusy' AND result='error'",[tenantId])).rowCount).toBe(1);
  });
  it('push acredita token+recurso, invalida caché y rechaza duplicados o números antiguos',async()=>{
    await connect();await availability();await slots();await slots();expect(deps.calendar.freebusy).toHaveBeenCalledTimes(1);
    const watch=vi.mocked(deps.calendar.watch).mock.calls[0][0];
    const headers={channelId:watch.channelId,channelToken:watch.channelToken,resourceId:'resource-opaque'};
    expect(await autenticarPushGoogle(app,headers)).toBe(tenantId);
    expect(await autenticarPushGoogle(app,{...headers,channelToken:randomBytes(32).toString('base64url')})).toBeNull();
    expect(await autenticarPushGoogle(app,{...headers,resourceId:'forged'})).toBeNull();
    expect(await procesarPushGoogle(app,{tenantId,channelId:watch.channelId,resourceId:'resource-opaque',messageNumber:'5'})).toEqual({changed:true});
    expect(await procesarPushGoogle(app,{tenantId,channelId:watch.channelId,resourceId:'resource-opaque',messageNumber:'5'})).toEqual({changed:false});
    expect(await procesarPushGoogle(app,{tenantId,channelId:watch.channelId,resourceId:'resource-opaque',messageNumber:'2'})).toEqual({changed:false});
    expect(await procesarPushGoogle(app,{tenantId:other,channelId:watch.channelId,resourceId:'resource-opaque',messageNumber:'8'})).toEqual({changed:false});
    vi.mocked(deps.calendar.freebusy).mockResolvedValue({primary:[{start:'2027-03-01T00:00:00Z',end:'2027-03-02T00:00:00Z'}]});
    expect(await slots()).toEqual([]);expect(deps.calendar.freebusy).toHaveBeenCalledTimes(2);
  });
  it('renueva con otra ID, admite solapamiento y no sondea freebusy',async()=>{
    await connect();const first=vi.mocked(deps.calendar.watch).mock.calls[0][0];
    await admin.query('UPDATE calendar_google_watches SET expires_at=$2 WHERE tenant_id=$1',[tenantId,new Date(instant.getTime()+10*60_000)]);
    await renovarWatchGoogle(app,{tenantId,userId},deps);
    expect(deps.calendar.watch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.calendar.watch).mock.calls[1][0].channelId).not.toBe(first.channelId);
    expect((await admin.query('SELECT 1 FROM calendar_google_watches WHERE tenant_id=$1',[tenantId])).rowCount).toBe(2);
    expect(deps.calendar.freebusy).not.toHaveBeenCalled();
  });
  it('el mantenimiento preselecciona solo conexiones con lease pendiente o caché vencido',async()=>{
    await connect();
    let candidates=await app.query('SELECT tenant_id FROM tenants_con_mantenimiento_google($1)',[instant]);
    expect(candidates.rows.map(r=>r.tenant_id)).not.toContain(tenantId);
    expect(candidates.rows.map(r=>r.tenant_id)).not.toContain(other);
    await admin.query('UPDATE calendar_google_watches SET expires_at=$2 WHERE tenant_id=$1',[tenantId,new Date(instant.getTime()+60_000)]);
    candidates=await app.query('SELECT tenant_id FROM tenants_con_mantenimiento_google($1)',[instant]);
    expect(candidates.rows.map(r=>r.tenant_id)).toContain(tenantId);
    await admin.query("UPDATE tenants SET state='suspended' WHERE id=$1",[tenantId]);
    candidates=await app.query('SELECT tenant_id FROM tenants_con_mantenimiento_google($1)',[instant]);
    expect(candidates.rows.map(r=>r.tenant_id)).not.toContain(tenantId);
    await admin.query("UPDATE tenants SET state='active' WHERE id=$1",[tenantId]);
    const result=await mantenerWatchesGoogle(app,deps);
    expect(result.renewed).toBeGreaterThanOrEqual(1);
    expect(deps.calendar.watch).toHaveBeenCalledTimes(2);
    expect(deps.calendar.freebusy).not.toHaveBeenCalled();
  });
  it('watch fallido se muestra pendiente y nunca habilita caché de datos viejos',async()=>{
    vi.mocked(deps.calendar.watch).mockRejectedValue(new Error('provider failure'));
    expect((await connect()).pushActive).toBe(false);await availability();await slots();await slots();
    expect(deps.calendar.freebusy).toHaveBeenCalledTimes(2);
  });
  it('refresh preserva el nuevo secreto aunque freebusy falle y limpia versiones viejas',async()=>{
    await connect();await availability();for(const [key,value] of versions){versions.set(key,JSON.stringify({...JSON.parse(value),expiresAt:0}));}
    vi.mocked(deps.calendar.freebusy).mockRejectedValueOnce(new Error('offline'));
    await expect(slots()).rejects.toThrow();expect(deps.oauth.refresh).toHaveBeenCalledTimes(1);
    await slots();expect(deps.oauth.refresh).toHaveBeenCalledTimes(1);
    expect((await limpiarSecretosGoogle(app,deps)).destroyed).toBeGreaterThanOrEqual(1);expect(versions.size).toBe(1);
    expect([...versions.values()][0]).toContain('refreshed-access');
  });
  it('invalid_grant exige reconectar y no ofrece agenda como si Google estuviera vacío',async()=>{
    await connect();await availability();for(const [key,value] of versions){versions.set(key,JSON.stringify({...JSON.parse(value),expiresAt:0}));}
    vi.mocked(deps.oauth.refresh).mockRejectedValue(new GoogleIntegrationError('GOOGLE_INVALID_GRANT',400));
    await expect(slots()).rejects.toThrow();expect((await estadoGoogleCalendar(app,{tenantId,userId},deps)).status).toBe('reauth_required');
    await expect(slots()).rejects.toThrow();
  });
  it('quitar la membresía impide consultar el calendario aunque conserve el grant',async()=>{
    await connect();await availability();
    await admin.query('DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId]);
    await expect(slots()).rejects.toThrow();expect(deps.calendar.freebusy).not.toHaveBeenCalled();
  });
});

describe('revocación de la cuenta Google',()=>{
  it('revoca todos sus grants entre tenants sin tocar otra cuenta y publica en cada tenant',async()=>{
    await connect();await connect(other,userId);
    const anotherUser=randomUUID();vi.mocked(deps.oauth.verifyIdToken).mockResolvedValue({sub:'another-person'});await connect(other,anotherUser);
    expect(await revocarGoogleCalendar(app,{tenantId,userId},deps)).toEqual({revoked:true});
    expect((await estadoGoogleCalendar(app,{tenantId:other,userId},deps)).status).toBe('revoked');
    expect((await estadoGoogleCalendar(app,{tenantId:other,userId:anotherUser},deps)).status).toBe('active');
    expect((await admin.query("SELECT 1 FROM outbox WHERE name='integration.revoked' AND tenant_id=ANY($1)",[[tenantId,other]])).rowCount).toBe(2);
    expect(versions.size).toBe(1);expect(deps.oauth.revoke).toHaveBeenCalledTimes(1);
  });
  it('un fallo SQL después del revoke remoto no restaura active y bloquea reconexión',async()=>{
    await connect();await connect(other,userId);
    const sinAudit=poolQueReescribe(app,desviarElAuditDe('integration.revoked'));
    await expect(revocarGoogleCalendar(sinAudit,{tenantId,userId},deps)).rejects.toThrow();
    // El invariante, no el mensaje: la auditoría del revoke no quedó escrita.
    expect((await admin.query(
      "SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='integration.revoked'",[tenantId])).rowCount).toBe(0);
    expect(deps.oauth.revoke).toHaveBeenCalledTimes(1);
    expect((await estadoGoogleCalendar(app,{tenantId,userId},deps)).status).toBe('revoking');
    expect((await estadoGoogleCalendar(app,{tenantId:other,userId},deps)).status).toBe('revoking');
    await expect(connect(other,userId)).rejects.toThrow();
    vi.mocked(deps.oauth.revoke).mockRejectedValue(new GoogleIntegrationError('GOOGLE_INVALID_TOKEN',400));
    expect(await revocarGoogleCalendar(app,{tenantId,userId},deps)).toEqual({revoked:true});
    expect((await estadoGoogleCalendar(app,{tenantId:other,userId},deps)).status).toBe('revoked');
  });
  it('un timeout conserva bloqueo durable y permite reintentar sin anunciar éxito',async()=>{
    await connect();await connect(other,userId);vi.mocked(deps.oauth.revoke).mockRejectedValueOnce(new GoogleIntegrationError('GOOGLE_TIMEOUT'));
    await expect(revocarGoogleCalendar(app,{tenantId,userId},deps)).rejects.toThrow(/todavía no confirmó/);
    expect((await estadoGoogleCalendar(app,{tenantId:other,userId},deps)).status).toBe('revoking');
    await expect(connect(other,userId)).rejects.toThrow();
    expect(await revocarGoogleCalendar(app,{tenantId,userId},deps)).toEqual({revoked:true});
    expect((await estadoGoogleCalendar(app,{tenantId:other,userId},deps)).status).toBe('revoked');
  });
  it('un refresh token ya inválido no impide revocar los otros grants conocidos',async()=>{
    await connect();await connect(other,userId);
    vi.mocked(deps.oauth.revoke).mockRejectedValueOnce(new GoogleIntegrationError('GOOGLE_INVALID_TOKEN',400));
    expect(await revocarGoogleCalendar(app,{tenantId,userId},deps)).toEqual({revoked:true});
    expect(deps.oauth.revoke).toHaveBeenCalledTimes(2);
    expect((await estadoGoogleCalendar(app,{tenantId:other,userId},deps)).status).toBe('revoked');
  });
  it('un usuario no puede revocar el grant de otro mediante la función sin contexto propio',async()=>{
    await connect();const id=(await admin.query('SELECT id FROM google_oauth_grants WHERE tenant_id=$1',[tenantId])).rows[0].id;
    expect((await withTenant(app,other,c=>c.query('SELECT * FROM google_grants_para_revocar($1,$2)',[id,userId]))).rowCount).toBe(0);
    expect((await withTenant(app,tenantId,c=>c.query('SELECT * FROM google_grants_para_revocar($1,$2)',[id,randomUUID()]))).rowCount).toBe(0);
    expect((await estadoGoogleCalendar(app,{tenantId,userId},deps)).status).toBe('active');
  });
  it('destrucción temporalmente caída queda en cola durable y se reintenta',async()=>{
    await connect();vi.mocked(deps.secrets.destroy).mockRejectedValueOnce(new Error('temporary'));
    expect(await revocarGoogleCalendar(app,{tenantId,userId},deps)).toEqual({revoked:true});
    expect((await admin.query('SELECT 1 FROM google_secret_versions WHERE tenant_id=$1 AND destroy_pending',[tenantId])).rowCount).toBeGreaterThanOrEqual(1);
    await limpiarSecretosGoogle(app,deps);expect(versions.size).toBe(0);
  });
});
