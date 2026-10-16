import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant, idsDeTenants } from '@iaxti/db';
import { GoogleIntegrationError, type GoogleOAuth, type GoogleSecretStore } from '@iaxti/google';
import {
  iniciarConsentimientoGoogle, consumirConsentimientoGoogle, grantGoogleDelUsuario,
  bloquearGrantGoogle, guardarGrantGoogle, actualizarTokenGoogle, marcarGoogleSinConsentimiento,
  prepararRevocacionGoogle, finalizarRevocacionGoogle, limpiarVersionesGoogle,
  reservarSecretoGoogle, bloquearIntentoSecretoGoogle, GOOGLE_SERVICE_SCOPES,
  type GoogleService, type GoogleGrant, type GoogleAudit, type GoogleRevocationTarget,
} from './google-grants';
import { roleOf } from './invitations';
import { tenantsConLimpiezaGoogle } from './google-cleanup-tenants';

/** Puertos de custodia y OAuth; no depende de módulos consumidores ni de audit. */
export interface GoogleConsentDeps {
  clientId: string; oauth: GoogleOAuth; secrets: GoogleSecretStore; ahora?: () => Date;
}
export interface GoogleConsentInput {
  tenantId: string; userId: string; service: GoogleService;
}
export interface GoogleCallbackInput extends GoogleConsentInput {
  state: string; verifier: string; nonce: string; code: string;
}
const now = (deps: GoogleConsentDeps) => deps.ahora?.() ?? new Date();
const unavailable = () => new Error('No pudimos comprobar Google. Reintenta o revisa la conexión.');
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


export async function iniciarGoogleConsent(pool: Pool, input: GoogleConsentInput & {challenge: string}, deps: GoogleConsentDeps, audit: GoogleAudit) {
  return withTenant(pool, input.tenantId, async c => {
    if (!await roleOf(c,input.tenantId,input.userId)) throw unavailable();
    const grant = await bloquearGrantGoogle(c,input);
    if (grant?.status === 'revoking') throw unavailable();
    const attempt = await iniciarConsentimientoGoogle(c,{...input,ahora:now(deps),audit});
    const scopes = [...new Set(['openid', ...GOOGLE_SERVICE_SCOPES[input.service],
      ...(grant && grant.status !== 'revoked' ? grant.scopes : [])])];
    return {...attempt,url:deps.oauth.authorizationUrl({...attempt,challenge:input.challenge,scopes})};
  });
}

/** El hook del servicio solo modifica datos propios en la misma transacción.
 * El protocolo OAuth/custodia y sus cerrojos permanecen compartidos. */
export async function completarGoogleConsent(pool: Pool, input: GoogleCallbackInput, deps: GoogleConsentDeps, audit: GoogleAudit,
  onConnected?: (c: PoolClient, grant: GoogleGrant) => Promise<void>): Promise<void> {
  // El consumo se confirma ANTES del intercambio. Un fallo externo nunca
  // vuelve a habilitar el mismo código/intento y tampoco oculta su auditoría.
  const consumed = await withTenant(pool, input.tenantId, (c) => consumirConsentimientoGoogle(c, { ...input, ahora: now(deps) }));
  if (!consumed) throw new Error('La conexión expiró o pertenece a otra sesión. Inicia nuevamente desde la integración.');
  const newSecretId = `iaxti-google-${randomUUID()}`;
  try {
    const tokens = await deps.oauth.exchange({ code: input.code, verifier: input.verifier });
    if (!tokens.idToken || GOOGLE_SERVICE_SCOPES[input.service].some(scope=>!tokens.scope.includes(scope))) throw unavailable();
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
      if (!await roleOf(c,input.tenantId,input.userId)) throw unavailable();
      // Releer después del bloqueo evita que un callback antiguo reemplace
      // un servicio añadido mientras Google mostraba la pantalla de consentimiento.
      if (existing && existing.status !== 'revoked' && existing.scopes.some(scope=>!tokens.scope.includes(scope))) throw unavailable();
      let refreshToken = tokens.refreshToken;
      if (!refreshToken && existing?.status === 'active' && existing.subject === identity.sub && existing.clientId === deps.clientId) {
        refreshToken = readTokens(await deps.secrets.access(existing.secretRef)).refreshToken;
      }
      if (!refreshToken) throw new Error('Google no entregó acceso sin conexión. Retira el permiso en tu cuenta de Google y vuelve a conectar.');
      const createdRef = await deps.secrets.put(newSecretId, JSON.stringify({
        accessToken: tokens.accessToken, refreshToken, expiresAt: now(deps).getTime() + tokens.expiresIn * 1000,
      } satisfies StoredTokens));
      const grant = await guardarGrantGoogle(c, { ...input, clientId: deps.clientId, subject: identity.sub,
        secretRef: createdRef, scopes: tokens.scope, audit });
      await onConnected?.(c,grant);
    });
  } catch {
    // La intención persistida permite recoger recursos incluso si put no
    // devolvió su versión. No se compensa aquí: COMMIT pudo tener resultado
    // incierto; el recolector comprueba que ningún grant activo lo usa.
    await withTenant(pool, input.tenantId, (c) => audit(c, { tenantId: input.tenantId, actor: input.userId,
      action: 'google.consent.failed', resourceId: input.userId, result: 'error' }));
    throw new Error('No se pudo guardar el permiso de Google. Vuelve a conectar desde la integración y acepta los permisos solicitados.');
  }
}

/** Siempre dentro del cerrojo de la cuenta Google, antes de tocar su secreto. */
async function accessToken(c: PoolClient, grant: GoogleGrant, deps: GoogleConsentDeps): Promise<string> {
  if (grant.status !== 'active' || grant.clientId !== deps.clientId || grant.services.some(service=>GOOGLE_SERVICE_SCOPES[service].some(scope=>!grant.scopes.includes(scope)))) throw unavailable();
  const saved = readTokens(await deps.secrets.access(grant.secretRef));
  if (saved.expiresAt > now(deps).getTime() + 60_000) return saved.accessToken;
  const fresh = await deps.oauth.refresh(saved.refreshToken);
  if (fresh.scope.length && grant.services.some(service=>GOOGLE_SERVICE_SCOPES[service].some(scope=>!fresh.scope.includes(scope)))) throw unavailable();
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
export async function conGoogleConsent<T>(pool: Pool | PoolClient, input: GoogleConsentInput & { action: string; actorId?: string }, deps: GoogleConsentDeps, audit: GoogleAudit,
  fn: (c: PoolClient, token: string, grant: GoogleGrant) => Promise<T>): Promise<T> {
  const outcome = await enTenant(pool, input.tenantId, async (c) => {
    const grant = await bloquearGrantGoogle(c, {...input,noEsperar:'release' in pool});
    if (!await roleOf(c,input.tenantId,input.userId)) return { error: true as const };
    if (!grant || grant.status !== 'active' || !grant.services.includes(input.service)) return { error: true as const };
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

export async function revocarGoogleConsent(pool: Pool, input: {tenantId:string;userId:string}, deps: GoogleConsentDeps, audit: GoogleAudit,
  onRevoked?: (c:PoolClient,target:GoogleRevocationTarget)=>Promise<void>) {
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
        await onRevoked?.(c,target);
      }
    } finally { await c.query("SELECT set_config('app.tenant_id',$1,true)",[input.tenantId]); }
    return true;
  });
  if (!success) throw new Error('Google todavía no confirmó la revocación. El acceso ya está bloqueado aquí; reintenta para terminar.');
  // La cola de destrucción ya quedó confirmada con la revocación. Un fallo
  // del almacén no puede restaurar el permiso: el worker reintenta esa cola.
  await limpiarGoogleConsent(pool,deps,audit).catch(()=>{});
  return { revoked: true };
}

export async function limpiarGoogleConsent(pool: Pool, injected: GoogleConsentDeps | null, audit: GoogleAudit): Promise<{destroyed:number;failed:number}> {
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

