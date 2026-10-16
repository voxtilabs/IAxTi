import { googleCalendarRoutes } from './google-calendar-routes.generated';
export interface GoogleCalendarState {
  configured: boolean;
  status: 'disconnected' | 'active' | 'reauth_required' | 'revoking' | 'revoked';
  calendarId: string | null;
  pushActive: boolean;
  lastNotificationAt: string | null;
}
export class GoogleCalendarSdkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly requestId: string) { super(message); }
}
/** Rutas generadas del contrato OpenAPI; ninguna credencial Google llega al SDK. */
export function googleCalendarClient(config: { apiUrl: string; token: string; tenantId: string }) {
  async function call<T>(operation: keyof typeof googleCalendarRoutes, body?: unknown, key?: string): Promise<T> {
    const route = googleCalendarRoutes[operation];
    const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${route.path}`, {
      method: route.method, cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${config.token}`, 'X-Tenant-Id': config.tenantId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new GoogleCalendarSdkError(result?.code ?? 'GOOGLE_REQUEST_FAILED',
      result?.message ?? 'No pudimos consultar la conexión con Google. Intenta otra vez.', response.status, result?.requestId ?? '');
    return result as T;
  }
  return {
    state: () => call<GoogleCalendarState>('GoogleCalendarController_estado'),
    // State y nonce no se cachean en la base mediante Idempotency-Key.
    start: (challenge: string) => call<{ state: string; nonce: string; url: string }>('GoogleCalendarController_iniciar', { challenge }),
    finish: (body: { code: string; state: string; nonce: string; verifier: string }, key: string) => call<GoogleCalendarState>('GoogleCalendarController_completar', body, key),
    revoke: (key: string) => call<{ revoked: true }>('GoogleCalendarController_revocar', undefined, key),
  };
}
