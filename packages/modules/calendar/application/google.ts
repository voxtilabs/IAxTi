import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant, idsDeTenants } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { zonaDelTenant } from '@iaxti/module-organizations';
import {
  iniciarConsentimientoGoogle, consumirConsentimientoGoogle, grantGoogleDelUsuario, roleOf,
  bloquearGrantGoogle, guardarGrantGoogle, actualizarTokenGoogle, marcarGoogleSinConsentimiento,
  prepararRevocacionGoogle, finalizarRevocacionGoogle, limpiarVersionesGoogle, reservarSecretoGoogle, bloquearIntentoSecretoGoogle, tenantsConLimpiezaGoogle, type GoogleAudit, type GoogleGrant,
} from '@iaxti/module-identity';
import { GOOGLE_CALENDAR_SCOPE, GoogleIntegrationError, type GoogleBusyInterval } from '@iaxti/google';
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

interface StoredTokens { accessToken: string; refreshToken: string; expiresAt: number }
function readTokens(payload: string): StoredTokens {
  try {
    const data = JSON.parse(payload) as StoredTokens;
    if (!data || typeof data.accessToken !== 'string' || !data.accessToken || typeof data.refreshToken !== 'string'
      || !data.refreshToken || !Number.isFinite(data.expiresAt)) throw new Error();
    return data;
  } catch { throw unavailable(); }
}
function secretId(ref: string) {
  const match = /^projects\/[^/]+\/secrets\/([A-Za-z0-9_-]+)\/versions\/[1-9][0-9]*$/.exec(ref);
  if (!match) throw unavailable();
  return match[1];
}

/** Resultado público sin subject, referencias de secretos ni credenciales. */
export async function estadoGoogleCalendar(pool: Pool, input: { tenantId: string; userId: string }, deps = calendarGoogleDesdeEntorno()) {
  return withTenant(pool, input.tenantId, async (c) => {
    const grant = await grantGoogleDelUsuario(c, input.tenantId, input.userId);
    const r = await c.query(`SELECT cc.calendar_id,cc.last_notification_at,
      (SELECT max(expires_at) FROM calendar_google_watches w WHERE w.connection_id=cc.id AND w.resource_id IS NOT NULL) AS watch_expires_at
      FROM calendar_connections cc WHERE cc.tenant_id=$1 AND cc.user_id=$2`, [input.tenantId,input.userId]);
    const row = r.rows[0];
    return { configured: Boolean(deps), status: grant?.status ?? 'disconnected', calendarId: row?.calendar_id ?? null,
      pushActive: Boolean(row?.watch_expires_at && new Date(row.watch_expires_at).getTime() > (deps ? now(deps).getTime() : Date.now())),
      lastNotificationAt: row?.last_notification_at ?? null };
  });
}

export async function iniciarGoogleCalendar(pool: Pool, input: { tenantId: string; userId: string; challenge: string }, injected = calendarGoogleDesdeEntorno()) {
  const deps = required(injected);
  return withTenant(pool, input.tenantId, async (c) => {
    const attempt = await iniciarConsentimientoGoogle(c, { ...input, ahora: now(deps), audit });
    return { ...attempt, url: deps.oauth.authorizationUrl({ ...attempt, challenge: input.challenge,
      scopes: ['openid', GOOGLE_CALENDAR_SCOPE] }) };
  });
}

export async function completarGoogleCalendar(pool: Pool, input: {
  tenantId: string; userId: string; state: string; verifier: string; nonce: string; code: string;
}, injected = calendarGoogleDesdeEntorno()) {
  const deps = required(injected);
  // El consumo se confirma ANTES del intercambio. Un fallo externo nunca
  // vuelve a habilitar el mismo código/intento y tampoco oculta su auditoría.
  const consumed = await withTenant(pool, input.tenantId, (c) => consumirConsentimientoGoogle(c, { ...input, ahora: now(deps) }));
  if (!consumed) throw new Error('La conexión expiró o pertenece a otra sesión. Inicia nuevamente desde Agenda.');
  const newSecretId = `iaxti-google-${randomUUID()}`;
  try {
    const tokens = await deps.oauth.exchange({ code: input.code, verifier: input.verifier });
    if (!tokens.idToken || !tokens.scope.includes(GOOGLE_CALENDAR_SCOPE)) throw unavailable();
    const identity = await deps.oauth.verifyIdToken({ idToken: tokens.idToken, nonce: input.nonce });
    await withTenant(pool,input.tenantId,c=>reservarSecretoGoogle(c,{...input,secretId:newSecretId,audit}));
    await withTenant(pool, input.tenantId, async (c) => {
      // También serializa dos consentimientos simultáneos de una persona.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`google-user:${input.tenantId}:${input.userId}`]);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`google:${deps.clientId}:${identity.sub}`]);
      await bloquearIntentoSecretoGoogle(c,{...input,secretId:newSecretId});
      const existing = await grantGoogleDelUsuario(c, input.tenantId, input.userId);
      if (existing && existing.status !== 'revoked' && (existing.subject !== identity.sub || existing.clientId !== deps.clientId)) {
        throw new Error('Revoca la conexión anterior antes de elegir otra cuenta de Google.');
      }
      let refreshToken = tokens.refreshToken;
      if (!refreshToken && existing?.status === 'active' && existing.subject === identity.sub && existing.clientId === deps.clientId) {
        refreshToken = readTokens(await deps.secrets.access(existing.secretRef)).refreshToken;
      }
      if (!refreshToken) throw new Error('Google no entregó acceso sin conexión. Retira el permiso en tu cuenta de Google y vuelve a conectar.');
      const createdRef = await deps.secrets.put(newSecretId, JSON.stringify({
        accessToken: tokens.accessToken, refreshToken, expiresAt: now(deps).getTime() + tokens.expiresIn * 1000,
      } satisfies StoredTokens));
      await guardarGrantGoogle(c, { ...input, clientId: deps.clientId, subject: identity.sub,
        secretRef: createdRef, scopes: tokens.scope, audit });
      await c.query(`INSERT INTO calendar_connections(id,tenant_id,user_id) VALUES($1,$2,$3)
        ON CONFLICT(tenant_id,user_id) DO UPDATE SET revision=calendar_connections.revision+1`, [randomUUID(),input.tenantId,input.userId]);
      // Un consentimiento nuevo invalida las vistas previas del anterior.
      await c.query(`DELETE FROM calendar_freebusy_cache WHERE tenant_id=$1 AND connection_id IN
        (SELECT id FROM calendar_connections WHERE tenant_id=$1 AND user_id=$2)`, [input.tenantId,input.userId]);
    });
  } catch {
    // La intención persistida permite recoger recursos incluso si put no
    // devolvió su versión. No se compensa aquí: COMMIT pudo tener resultado
    // incierto; el recolector comprueba que ningún grant activo lo usa.
    await withTenant(pool, input.tenantId, (c) => audit(c, { tenantId: input.tenantId, actor: input.userId,
      action: 'google.consent.failed', resourceId: input.userId, result: 'error' }));
    throw new Error('No se pudo guardar el permiso de Google. Vuelve a conectar desde Agenda y acepta el acceso al calendario.');
  }
  // El consentimiento ya es durable. Si Google rechaza el webhook, la UI
  // muestra push pendiente y el worker reintenta; los huecos se consultan vivos.
  await renovarWatchGoogle(pool, input, deps).catch(() => {});
  return estadoGoogleCalendar(pool, input, deps);
}

/** Siempre dentro del cerrojo de la cuenta Google, antes de tocar su secreto. */
async function accessToken(c: PoolClient, grant: GoogleGrant, deps: CalendarGoogleDeps): Promise<string> {
  if (grant.status !== 'active' || grant.clientId !== deps.clientId || !grant.scopes.includes(GOOGLE_CALENDAR_SCOPE)) throw unavailable();
  const saved = readTokens(await deps.secrets.access(grant.secretRef));
  if (saved.expiresAt > now(deps).getTime() + 60_000) return saved.accessToken;
  const fresh = await deps.oauth.refresh(saved.refreshToken);
  if (fresh.scope.length && !fresh.scope.includes(GOOGLE_CALENDAR_SCOPE)) throw unavailable();
  const ref = await deps.secrets.addVersion(secretId(grant.secretRef), JSON.stringify({ accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken ?? saved.refreshToken, expiresAt: now(deps).getTime() + fresh.expiresIn * 1000 } satisfies StoredTokens));
  await actualizarTokenGoogle(c, { grant, secretRef: ref });
  return fresh.accessToken;
}

/** El copiloto ya tiene una transacción y puede tener el cerrojo de auditoría.
 * Reutiliza ese cliente: abrir otra conexión se autoesperaría, incluso con
 * pool max=1. En ese camino el commit/audit pertenecen al invocador. */
function enTenant<T>(db:Pool|PoolClient,tenantId:string,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  return 'release' in db ? fn(db) : withTenant(db,tenantId,fn);
}

/** Captura fallos antes del COMMIT para conservar audit y reauth_required. */
async function conGoogle<T>(pool: Pool | PoolClient, input: { tenantId: string; userId: string; action: string; actorId?: string }, deps: CalendarGoogleDeps,
  fn: (c: PoolClient, token: string, grant: GoogleGrant) => Promise<T>): Promise<T> {
  const outcome = await enTenant(pool, input.tenantId, async (c) => {
    const grant = await bloquearGrantGoogle(c, {...input,noEsperar:'release' in pool});
    if (!await roleOf(c,input.tenantId,input.userId)) return { error: true as const };
    if (!grant || grant.status !== 'active') return { error: true as const };
    // Los errores SQL se propagan para rollback; solo los externos se
    // convierten a resultados. Un SAVEPOINT conserva el audit de rechazo.
    await c.query('SAVEPOINT google_access');
    try {
      const token = await accessToken(c, grant, deps);
      await c.query('RELEASE SAVEPOINT google_access');
      await c.query('SAVEPOINT google_access');
      const value = await fn(c, token, grant);
      await audit(c, { ...input, actor: input.actorId ?? input.userId, resourceId: grant.id, result: 'ok' });
      return { error: false as const, value };
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT google_access');
      if (error instanceof GoogleIntegrationError && (error.status === 401 || error.code === 'GOOGLE_INVALID_GRANT')) {
        await marcarGoogleSinConsentimiento(c, { grant, audit });
      }
      await audit(c, { ...input, actor: input.actorId ?? input.userId, resourceId: grant.id, result: 'error' });
      return { error: true as const };
    }
  });
  if (outcome.error) throw unavailable();
  return outcome.value;
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
      if (grant?.status !== 'active') continue;
      try { await renovarWatchGoogle(pool,{tenantId,userId:row.user_id},injected); renewed++; } catch { failed++; }
    }
  }
  return { renewed, failed };
}

export async function revocarGoogleCalendar(pool: Pool, input: { tenantId: string; userId: string }, injected = calendarGoogleDesdeEntorno()) {
  const deps = required(injected);
  // El bloqueo local se confirma ANTES de revocar en Google. Si el proceso
  // cae o falla la auditoría/COMMIT posterior, nunca vuelve a quedar active.
  await withTenant(pool,input.tenantId,async c=>{
    const source=await bloquearGrantGoogle(c,input);
    if(!source || source.status==='revoked')return;
    if(source.clientId!==deps.clientId)throw unavailable();
    await prepararRevocacionGoogle(c,{...input,audit});
  });
  const success = await withTenant(pool,input.tenantId,async c => {
    // El cerrojo de la cuenta dura también durante la petición remota. Un
    // segundo revoke/refresh/consentimiento espera, incluso en otro tenant.
    const source = await bloquearGrantGoogle(c,input);
    if (!source || source.status === 'revoked') return true;
    if (source.clientId !== deps.clientId) throw unavailable();
    const targets = await prepararRevocacionGoogle(c,{...input,audit});
    try {
      // Un token ya vencido puede responder invalid_token. Se prueban los
      // demás grants conocidos de la cuenta; un revoke confirmado afecta a
      // todos. Si todos son inválidos, ninguno permite acceso desde IAxTi.
      for (const target of [...targets].sort((a,b)=>Number(b.id===source.id)-Number(a.id===source.id))) {
        const tokens = readTokens(await deps.secrets.access(target.secretRef));
        try { await deps.oauth.revoke(tokens.refreshToken); break; }
        catch (error) {
          if (!(error instanceof GoogleIntegrationError && error.code==='GOOGLE_INVALID_TOKEN')) throw error;
        }
      }
    } catch {
      await audit(c,{tenantId:input.tenantId,actor:input.userId,
        action:'google.revocation.failed',resourceId:source.id,result:'error'});
      return false;
    }
    try {
      for (const target of [...targets].sort((a,b)=>a.tenantId.localeCompare(b.tenantId))) {
        await c.query("SELECT set_config('app.tenant_id',$1,true)",[target.tenantId]);
        await finalizarRevocacionGoogle(c,{target,audit});
        await c.query('DELETE FROM calendar_connections WHERE tenant_id=$1 AND user_id=$2',[target.tenantId,target.userId]);
      }
    } finally { await c.query("SELECT set_config('app.tenant_id',$1,true)",[input.tenantId]); }
    return true;
  });
  if (!success) throw new Error('Google todavía no confirmó la revocación. El acceso ya está bloqueado aquí; reintenta para terminar.');
  // La cola de destrucción ya quedó confirmada con la revocación. Un fallo
  // del almacén no puede restaurar el permiso: el worker reintenta esa cola.
  await limpiarSecretosGoogle(pool,deps).catch(()=>{});
  return { revoked: true };
}

export async function limpiarSecretosGoogle(pool: Pool, injected = calendarGoogleDesdeEntorno()): Promise<{destroyed:number;failed:number}> {
  const result={destroyed:0,failed:0};
  if (!injected) return result;
  const ids=await tenantsConLimpiezaGoogle(pool);
  for (const tenantId of await idsDeTenants(pool,{ids})) {
    try{
      const tenantResult=await withTenant(pool,tenantId,c=>limpiarVersionesGoogle(c,{tenantId,
        destroy:ref=>injected.secrets.destroy(ref),deleteSecret:id=>injected.secrets.deleteSecret(id),audit}));
      result.destroyed+=tenantResult.destroyed;
      result.failed+=tenantResult.failed;
    }catch{
      // Un fallo de transacción cuenta como un intento fallido y deja sus
      // pendientes durables; no cancela la limpieza de los demás negocios.
      result.failed++;
    }
  }
  return result;
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
  if (!grant || grant.status === 'revoked') return enTenant(pool,input.tenantId,c => huecosDelDia(c,input));
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
