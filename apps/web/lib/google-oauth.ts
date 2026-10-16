const PREFIX = 'iaxti-google-oauth:';
export interface GooglePending { service?: 'calendar' | 'drive' | 'gmail'; tenantId: string; userId: string; nonce: string; verifier: string; createdAt: number; key: string }
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** El verifier existe solo en la pestaña que inició el consentimiento. */
export async function googlePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
export function saveGooglePending(state: string, pending: GooglePending, storage: Storage = sessionStorage): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('Google no entregó un intento válido. Conecta otra vez.');
  storage.setItem(PREFIX + state, JSON.stringify(pending));
}
export function readGooglePending(state: string, tenantId: string, userId: string, storage: Storage = sessionStorage, now = Date.now()): GooglePending {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error();
    const pending = JSON.parse(storage.getItem(PREFIX + state) ?? 'null') as GooglePending | null;
    if (!pending || pending.tenantId !== tenantId || pending.userId !== userId
      || !/^[A-Za-z0-9_-]{43}$/.test(pending.nonce) || !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier)
      || typeof pending.key !== 'string' || !Number.isFinite(pending.createdAt)
      || now < pending.createdAt || now - pending.createdAt > 600_000) throw new Error();
    return pending;
  } catch { throw new Error('Este permiso expiró o se inició en otra sesión o negocio. Vuelve a conectar desde Agenda.'); }
}
export function clearGooglePending(state: string, storage: Storage = sessionStorage): void { storage.removeItem(PREFIX + state); }
