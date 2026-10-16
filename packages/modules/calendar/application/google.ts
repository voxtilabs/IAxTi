import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant, idsDeTenants } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { zonaDelTenant } from '@iaxti/module-organizations';
import {
  grantGoogleDelUsuario, iniciarGoogleConsent, completarGoogleConsent, conGoogleConsent,
  revocarGoogleConsent, limpiarGoogleConsent, type GoogleAudit, type GoogleGrant,
} from '@iaxti/module-identity';
import { type GoogleBusyInterval } from '@iaxti/google';
import { huecosDelDia, listarDisponibilidad, type HuecoOfrecido } from './agenda';
import { calendarGoogleDesdeEntorno, type CalendarGoogleDeps } from './google-config';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const audit: GoogleAudit = async (client, e) => {
  await writeAudit(client, { ...e, resource: 'google_integration', actorKind: e.actor === 'system' ? 'system' : 'user' });
};
const now = (deps: CalendarGoogleDeps) => deps.ahora?.() ?? new Date();
const unavailable = () => new Error('No pudimos comprobar Google Calendar. Reintenta o revisa la conexión antes de ofrecer horarios.');
function required(deps: CalendarGoogleDeps | null): CalendarGoogleDeps {
  if (!deps) throw new Error('Google Calendar todavía no está configurado en este entorno.');
  return deps;
}

/** Resultado público sin subject, referencias de secretos ni credenciales. */
export async function estadoGoogleCalendar(pool: Pool, input: { tenantId: string; userId: string }, deps = calendarGoogleDesdeEntorno()) {
  return withTenant(pool, input.tenantId, async (c) => {
    const grant = await grantGoogleDelUsuario(c, input.tenantId, input.userId);
    const r = await c.query(`SELECT cc.calendar_id,cc.last_notification_at,
      (SELECT max(expires_at) FROM calendar_google_watches w WHERE w.connection_id=cc.id AND w.resource_id IS NOT NULL) AS watch_expires_at
      FROM calendar_connections cc WHERE cc.tenant_id=$1 AND cc.user_id=$2`, [input.tenantId,input.userId]);
    const row = r.rows[0];
    return { configured: Boolean(deps), status: grant?.services.includes('calendar') ? grant.status : 'disconnected', calendarId: row?.calendar_id ?? null,
      pushActive: Boolean(row?.watch_expires_at && new Date(row.watch_expires_at).getTime() > (deps ? now(deps).getTime() : Date.now())),
      lastNotificationAt: row?.last_notification_at ?? null };
  });
}

export async function iniciarGoogleCalendar(pool: Pool, input: { tenantId: string; userId: string; challenge: string }, injected = calendarGoogleDesdeEntorno()) {
  const deps = required(injected);
  return iniciarGoogleConsent(pool,{...input,service:'calendar'},deps,audit);
}

export async function completarGoogleCalendar(pool: Pool, input: {
  tenantId: string; userId: string; state: string; verifier: string; nonce: string; code: string;
}, injected = calendarGoogleDesdeEntorno()) {
  const deps=required(injected);
  await completarGoogleConsent(pool,{...input,service:'calendar'},deps,audit,async c=>{
    await c.query(`INSERT INTO calendar_connections(id,tenant_id,user_id) VALUES($1,$2,$3)
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET revision=calendar_connections.revision+1`,[randomUUID(),input.tenantId,input.userId]);
    await c.query(`DELETE FROM calendar_freebusy_cache WHERE tenant_id=$1 AND connection_id IN
      (SELECT id FROM calendar_connections WHERE tenant_id=$1 AND user_id=$2)`,[input.tenantId,input.userId]);
  });
  await renovarWatchGoogle(pool,input,deps).catch(()=>{});
  return estadoGoogleCalendar(pool,input,deps);
}

function conGoogle<T>(pool:Pool|PoolClient,input:{tenantId:string;userId:string;action:string;actorId?:string},deps:CalendarGoogleDeps,
  fn:(c:PoolClient,token:string,grant:GoogleGrant)=>Promise<T>):Promise<T>{
  return conGoogleConsent(pool,{...input,service:'calendar'},deps,audit,fn);
}

function enTenant<T>(db:Pool|PoolClient,tenantId:string,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  return 'release' in db ? fn(db) : withTenant(db,tenantId,fn);
}

export async function renovarWatchGoogle(pool: Pool, input: { tenantId: string; userId: string }, injected = calendarGoogleDesdeEntorno()): Promise<void> {
  const deps = required(injected);
  await conGoogle(pool, { ...input, action: 'google.calendar.watch' }, deps, async (c, token) => {
    const r = await c.query('SELECT * FROM calendar_connections WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [input.tenantId,input.userId]);
    const connection = r.rows[0];
    if (!connection) throw unavailable();
    const current = await c.query(`SELECT 1 FROM calendar_google_watches WHERE tenant_id=$1 AND connection_id=$2
      AND resource_id IS NOT NULL AND expires_at>$3 LIMIT 1`, [input.tenantId,connection.id,new Date(now(deps).getTime()+3_600_000)]);
    if (current.rowCount) return;
    const id = randomUUID(); const channelToken = randomBytes(32).toString('base64url');
    const channel = await deps.calendar.watch({ accessToken: token, calendarId: connection.calendar_id,
      channelId: id, channelToken, address: deps.webhookAddress, expiration: now(deps).getTime()+6*86_400_000 });
    if (channel.expiration <= now(deps).getTime()) throw unavailable();
    await c.query(`INSERT INTO calendar_google_watches(id,tenant_id,connection_id,token_hash,resource_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [id,input.tenantId,connection.id,digest(channelToken),channel.resourceId,new Date(channel.expiration)]);
    // Cada lease nueva exige una lectura viva. La notificación inicial sync
    // puede llegar ANTES de watch; es un aviso de arranque, no datos perdidos.
    await c.query('DELETE FROM calendar_freebusy_cache WHERE tenant_id=$1 AND connection_id=$2',[input.tenantId,connection.id]);
    await c.query('DELETE FROM calendar_google_watches WHERE tenant_id=$1 AND connection_id=$2 AND expires_at<$3',[input.tenantId,connection.id,now(deps)]);
  });
}

/** Solo renueva leases; jamás sondea eventos ni free/busy en segundo plano. */
export async function mantenerWatchesGoogle(pool: Pool, injected = calendarGoogleDesdeEntorno()) {
  if (!injected) return { renewed: 0, failed: 0 };
  let renewed = 0; let failed = 0;
  const candidates=await pool.query<{tenant_id:string}>('SELECT tenant_id FROM tenants_con_mantenimiento_google($1)',[now(injected)]);
  const ids=candidates.rows.map(row=>row.tenant_id);
  for (const tenantId of await idsDeTenants(pool, { ids })) {
    const users = await withTenant(pool,tenantId,async (c) => {
      await c.query('DELETE FROM calendar_freebusy_cache WHERE tenant_id=$1 AND expires_at<=$2',[tenantId,now(injected)]);
      return (await c.query(`SELECT user_id FROM calendar_connections cc
      WHERE tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM calendar_google_watches w WHERE w.connection_id=cc.id
        AND w.resource_id IS NOT NULL AND w.expires_at>$2)`,[tenantId,new Date(now(injected).getTime()+3_600_000)])).rows;
    });
    for (const row of users) {
      const grant = await withTenant(pool,tenantId,c => grantGoogleDelUsuario(c,tenantId,row.user_id));
      if (grant?.status !== 'active' || !grant.services.includes('calendar')) continue;
      try { await renovarWatchGoogle(pool,{tenantId,userId:row.user_id},injected); renewed++; } catch { failed++; }
    }
  }
  return { renewed, failed };
}

export async function revocarGoogleCalendar(pool: Pool, input: { tenantId: string; userId: string }, injected = calendarGoogleDesdeEntorno()) {
  const deps = required(injected);
  return revocarGoogleConsent(pool,input,deps,audit,async(c,target)=>{
    await c.query('DELETE FROM calendar_connections WHERE tenant_id=$1 AND user_id=$2',[target.tenantId,target.userId]);
  });
}

export async function limpiarSecretosGoogle(pool: Pool, injected = calendarGoogleDesdeEntorno()): Promise<{destroyed:number;failed:number}> {
  return limpiarGoogleConsent(pool,injected,audit);
}

/** Resuelve tenant SOLO con credencial del canal de Google y recurso exacto. */
export async function autenticarPushGoogle(pool: Pool, input: { channelId: string; channelToken: string; resourceId: string }): Promise<string|null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.channelId) || !/^[A-Za-z0-9_-]{43}$/.test(input.channelToken)
    || !input.resourceId || input.resourceId.length>1024) return null;
  const r = await pool.query('SELECT tenant_del_watch_google($1,$2,$3) AS tenant',[input.channelId,digest(input.channelToken),input.resourceId]);
  return r.rows[0]?.tenant ?? null;
}

export async function procesarPushGoogle(pool: Pool, input: { tenantId: string; channelId: string; resourceId: string; messageNumber: string }) {
  if (!/^[1-9][0-9]{0,29}$/.test(input.messageNumber)) throw unavailable();
  return withTenant(pool,input.tenantId,async c => {
    const r = await c.query(`UPDATE calendar_google_watches SET last_message=$4
      WHERE tenant_id=$1 AND id=$2 AND resource_id=$3 AND expires_at>now() AND last_message<$4
      RETURNING connection_id`,[input.tenantId,input.channelId,input.resourceId,input.messageNumber]);
    if (!r.rowCount) return { changed:false };
    const connectionId = r.rows[0].connection_id;
    await c.query('UPDATE calendar_connections SET revision=revision+1,last_notification_at=now() WHERE tenant_id=$1 AND id=$2',[input.tenantId,connectionId]);
    await c.query('DELETE FROM calendar_freebusy_cache WHERE tenant_id=$1 AND connection_id=$2',[input.tenantId,connectionId]);
    await audit(c,{tenantId:input.tenantId,actor:'system',action:'google.calendar.push',resourceId:connectionId,result:'ok'});
    return { changed:true };
  });
}

/** Consulta la agenda real y aplica cada buffer en INSTANTES, incluso de noche/DST. */
export async function huecosConGoogle(pool: Pool | PoolClient, input: { tenantId: string; ownerId: string; dia: string; ahora?: Date; actorId?: string }, injected = calendarGoogleDesdeEntorno()): Promise<HuecoOfrecido[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dia)) throw new Error('El día va como AAAA-MM-DD.');
  const grant = await enTenant(pool,input.tenantId,c => grantGoogleDelUsuario(c,input.tenantId,input.ownerId));
  // Quien nunca conectó Google sigue con su agenda local. Una conexión rota
  // NO se confunde con un calendario vacío ni ofrece sus horas como libres.
  if (!grant || !grant.services.includes('calendar') || grant.status === 'revoked') return enTenant(pool,input.tenantId,c => huecosDelDia(c,input));
  const deps = required(injected);
  return conGoogle(pool,{tenantId:input.tenantId,userId:input.ownerId,actorId:input.actorId,action:'google.calendar.freebusy'},deps,async (c,token) => {
    const r = await c.query('SELECT * FROM calendar_connections WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[input.tenantId,input.ownerId]);
    const connection = r.rows[0];
    if (!connection) throw unavailable();
    const zona = await zonaDelTenant(c,input.tenantId);
    const windows = await listarDisponibilidad(c,{tenantId:input.tenantId,ownerId:input.ownerId});
    const padding = Math.max(0,...windows.map(w=>w.respiro));
    const bounds = await c.query(`SELECT ($1::date::timestamp AT TIME ZONE $2)-make_interval(mins=>$3) AS start,
      (($1::date+1)::timestamp AT TIME ZONE $2)+make_interval(mins=>$3) AS finish`,[input.dia,zona,padding]);
    const cached = await c.query(`SELECT cache.busy FROM calendar_freebusy_cache cache
      WHERE cache.tenant_id=$1 AND connection_id=$2 AND day=$3 AND timezone=$4 AND revision=$5 AND cache.expires_at>$6
      AND EXISTS(SELECT 1 FROM calendar_google_watches w WHERE w.connection_id=$2 AND w.resource_id IS NOT NULL AND w.expires_at>$6)`,
    [input.tenantId,connection.id,input.dia,zona,connection.revision,now(deps)]);
    if (cached.rowCount) return filtrar(c,cached.rows[0].busy as GoogleBusyInterval[]);
    const result = await deps.calendar.freebusy({accessToken:token,calendarIds:[connection.calendar_id],
      timeMin:bounds.rows[0].start.toISOString(),timeMax:bounds.rows[0].finish.toISOString(),timeZone:zona});
    const intervals = result[connection.calendar_id];
    if (!intervals) throw unavailable();
    await c.query(`INSERT INTO calendar_freebusy_cache(tenant_id,connection_id,day,timezone,revision,busy,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,connection_id,day) DO UPDATE
      SET timezone=EXCLUDED.timezone,revision=EXCLUDED.revision,busy=EXCLUDED.busy,expires_at=EXCLUDED.expires_at`,
    [input.tenantId,connection.id,input.dia,zona,connection.revision,JSON.stringify(intervals),new Date(now(deps).getTime()+60_000)]);
    return filtrar(c,intervals);
  });
  async function filtrar(c:PoolClient,busy:GoogleBusyInterval[]) {
    const slots = await huecosDelDia(c,input);
    const windows = await listarDisponibilidad(c,{tenantId:input.tenantId,ownerId:input.ownerId});
    const weekday = Number((await c.query('SELECT EXTRACT(dow FROM $1::date) AS day',[input.dia])).rows[0].day);
    return slots.filter(slot => {
      const buffer = (windows.find(w => w.weekday===weekday && w.inicio<=slot.hora && w.fin>slot.hora)?.respiro ?? 0)*60_000;
      return !busy.some(b => Date.parse(b.start)<slot.fin.getTime()+buffer && Date.parse(b.end)>slot.inicio.getTime()-buffer);
    });
  }
}
