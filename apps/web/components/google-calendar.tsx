'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { googleCalendarClient, GoogleCalendarSdkError, type GoogleCalendarState } from '@iaxti/sdk';
import { AvisoResultado, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EncabezadoDePagina, Skeleton, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { useArranque } from './arranque';
import { clearGooglePending, googlePkce, readGooglePending, saveGooglePending } from '../lib/google-oauth';

function errorText(error: unknown) {
  return { text: error instanceof Error ? error.message : 'No pudimos completar la conexión. Intenta otra vez.',
    trace: error instanceof GoogleCalendarSdkError ? [error.code, error.requestId].filter(Boolean).join(' · ') : '' };
}
function Notice({ error }: { error: ReturnType<typeof errorText> | null }) {
  return error ? <AvisoResultado persistente tono="error">{error.text}{error.trace && <p className="mt-2 break-all font-mono text-xs">{error.trace}</p>}</AvisoResultado> : null;
}
export function GoogleCalendarConnection() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const { arranque } = useArranque();
  if (!session || !tenant) return null;
  return <Connection key={`${tenant}|${session.access_token}`} apiUrl={config.apiUrl} token={session.access_token}
    tenantId={tenant} userId={session.user.id} canConnect={Boolean(arranque?.permisos?.includes('calendar.connect'))} />;
}
function Connection({ apiUrl, token, tenantId, userId, canConnect }: {
  apiUrl: string; token: string; tenantId: string; userId: string; canConnect: boolean;
}) {
  const client = useMemo(() => googleCalendarClient({ apiUrl, token, tenantId }), [apiUrl, token, tenantId]);
  const [data, setData] = useState<GoogleCalendarState | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  const flight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void client.state().then((value) => { if (!cancelled) { setData(value); setError(null); } },
      (cause) => { if (!cancelled) setError(errorText(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, attempt]);
  async function connect() {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null);
    try {
      const { verifier, challenge } = await googlePkce();
      const pending = await client.start(challenge);
      if (!alive.current) return;
      const target = new URL(pending.url);
      if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') throw new Error('No pudimos abrir el permiso de Google. Intenta nuevamente.');
      saveGooglePending(pending.state, { verifier, nonce: pending.nonce, tenantId, userId, createdAt: Date.now(), key: crypto.randomUUID() });
      window.location.assign(target.href);
    } catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { if (alive.current) { flight.current = false; setBusy(false); } }
  }
  async function revoke() {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null);
    try {
      await client.revoke(crypto.randomUUID());
      if (alive.current) {
        setData({ configured: true, status: 'revoked', calendarId: null, pushActive: false, lastNotificationAt: null });
        setConfirm(false);
      }
    } catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { if (alive.current) { flight.current = false; setBusy(false); } }
  }
  const linked = data && !['disconnected', 'revoked'].includes(data.status);
  return <section className="pulso-panel my-6 rounded-tarjeta border border-line bg-raised p-4" aria-label="Google Calendar" aria-busy={loading || busy}>
    <h2 className="text-lg font-bold text-ink">Google Calendar</h2>
    <p className="mt-1 text-sm text-body">Conecta tu calendario para ofrecer horas que respeten tus compromisos. No leemos títulos ni contenidos de tus eventos.</p>
    <div className="mt-3"><Notice error={error} /></div>
    {loading && !data ? <Skeleton className="mt-3 h-16 w-full" /> : data ? <>
      <div className="mt-3"><Badge role={data.status === 'active' ? 'good' : 'neutral'}>{data.status === 'active' ? 'Permiso conectado' : data.status === 'revoking' ? 'Revocación pendiente' : data.status === 'reauth_required' ? 'Necesita autorización' : 'Sin conectar'}</Badge></div>
      {!data.configured ? <p className="mt-3 text-sm text-body">La conexión con Google aún no está habilitada en este entorno. Pide ayuda al equipo de soporte.</p> : <>
        {data.status === 'active' && <p className="mt-3 text-sm text-body">{data.pushActive ? 'Los cambios de tu calendario avisan a la agenda.' : 'Las notificaciones de cambios están pendientes. Seguimos consultando tu disponibilidad al ofrecer horas.'}</p>}
        {data.status === 'reauth_required' && <p className="mt-3 text-sm text-body">Google necesita que autorices el acceso nuevamente. Mientras tanto no ofrecemos horarios de esta conexión.</p>}
        {data.status === 'revoking' && <p className="mt-3 text-sm text-body">El acceso ya está bloqueado aquí. Reintenta la revocación para que Google la confirme.</p>}
        {canConnect ? <div className="mt-4 flex flex-wrap gap-2">
          {data.status !== 'revoking' && <Button variant="secundario" disabled={busy} onClick={() => void connect()}>{busy ? 'Un momento…' : linked ? 'Volver a autorizar' : 'Conectar Google Calendar'}</Button>}
          {linked && <Button variant="fantasma" disabled={busy} onClick={() => setConfirm(true)}>Revocar permisos</Button>}
        </div> : <p className="mt-3 text-sm text-muted">Necesitas permiso para conectar tu calendario en este negocio.</p>}
      </>}
    </> : <Button variant="secundario" className="mt-3" onClick={() => setAttempt((n) => n + 1)}>Reintentar</Button>}
    <Dialog open={confirm} onOpenChange={(value) => { if (!busy) setConfirm(value); }}><DialogContent>
      <DialogHeader><DialogTitle>Revocar permisos de Google</DialogTitle><DialogDescription>Google retirará todos los permisos de esta cuenta concedidos a IAxTi, también los usados en otros negocios o servicios de la aplicación. Para volver a usarlos tendrás que autorizar de nuevo.</DialogDescription></DialogHeader>
      <Notice error={error} />
      <DialogFooter className="flex-col sm:flex-row"><Button variant="fantasma" disabled={busy} onClick={() => setConfirm(false)}>Volver</Button><Button aria-label="Revocar permisos de Google" disabled={busy} onClick={() => void revoke()}>{busy ? 'Revocando…' : 'Revocar permisos'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}

export function GoogleCalendarCallback() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [params, setParams] = useState<URLSearchParams | null>(null);
  const captured = useRef<URLSearchParams | null>(null);
  useEffect(() => {
    captured.current ??= new URLSearchParams(window.location.search);
    // El código no queda en historial, enlaces ni peticiones de navegación.
    window.history.replaceState(null, '', window.location.pathname);
    setParams(captured.current);
  }, []);
  if (!session || !tenant || !params) return <p role="status">Esperando tu sesión para terminar la conexión…</p>;
  return <Finish key={`${tenant}|${session.access_token}`} apiUrl={config.apiUrl} token={session.access_token}
    tenantId={tenant} userId={session.user.id} params={params} />;
}
function Finish({ apiUrl, token, tenantId, userId, params }: {
  apiUrl: string; token: string; tenantId: string; userId: string; params: URLSearchParams;
}) {
  const [data, setData] = useState<GoogleCalendarState | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const promise = useRef<Promise<GoogleCalendarState> | null>(null);
  useEffect(() => {
    let cancelled = false;
    promise.current ??= (async () => {
      const state = params.get('state') ?? '';
      const pending = readGooglePending(state, tenantId, userId);
      try {
        if (params.has('error')) throw new Error('No autorizaste el acceso a Google Calendar. Puedes volver a conectar desde Agenda.');
        const code = params.get('code');
        if (!code) throw new Error('Google no entregó el permiso. Vuelve a conectar desde Agenda.');
        return await googleCalendarClient({ apiUrl, token, tenantId }).finish({ state, code, nonce: pending.nonce, verifier: pending.verifier }, pending.key);
      } finally { clearGooglePending(state); }
    })();
    void promise.current.then((value) => { if (!cancelled) setData(value); }, (cause) => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [apiUrl, token, tenantId, userId, params]);
  return <section className="pulso-panel rounded-tarjeta border border-line bg-raised p-4" aria-label="Conexión de Google Calendar">
    <EncabezadoDePagina titulo="Conexión de Google Calendar" />
    <div className="mt-3"><Notice error={error} /></div>
    {data ? <AvisoResultado persistente tono="success">{data.pushActive ? 'Tu calendario quedó conectado.' : 'El permiso quedó guardado. Las notificaciones de cambios siguen pendientes; la agenda consulta tu disponibilidad al ofrecer horas.'}</AvisoResultado> : !error && <p role="status" className="mt-3 text-sm text-body">Guardando tu permiso…</p>}
    <a href="/agenda" className="mt-4 inline-block text-action-text underline">Volver a Agenda</a>
  </section>;
}
