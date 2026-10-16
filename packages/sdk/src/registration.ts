import { registrationRoutes } from './registration-routes.generated';

export interface BusinessMembership { tenantId: string; tenantName: string; roleName: string }
export interface BusinessRegistration {
  displayName: string; name: string; description: string;
  vertical: 'belleza' | 'salud' | 'inmobiliaria' | 'retail' | 'servicios' | 'otro';
}
export interface OnboardingBusiness {
  name: string; vertical: string; description: string;
  plan: string; state: string; trialEndsAt: string | null;
}
export interface OnboardingCosts {
  cicloEnCurso: { metaUsd: number; usdClpRate: number; ia: { usd: number; clp: number } | null } | null;
}
interface Config { apiUrl: string; token: string; tenantId?: string }

export class RegistrationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly requestId: string) { super(message); }
}

async function request<T>(config: Config, operation: keyof typeof registrationRoutes, init: RequestInit): Promise<T> {
  const route = registrationRoutes[operation];
  const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${route.path}`, {
    ...init, method: route.method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(config.tenantId ? { 'X-Tenant-Id': config.tenantId } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string; code?: string; requestId?: string } | null;
    throw new RegistrationError(body?.code ?? 'ERROR', body?.message ?? 'No pudimos cargar tu negocio. Intenta de nuevo.', response.status, body?.requestId ?? '');
  }
  return response.json() as Promise<T>;
}
export function myBusinesses(config: Config, signal?: AbortSignal) {
  return request<{ tenants: BusinessMembership[] }>(config, 'memberships', { signal });
}
export function registerBusiness(config: Config, body: BusinessRegistration, key: string, signal?: AbortSignal) {
  return request<BusinessMembership>(config, 'register', { body: JSON.stringify(body), signal, headers: { 'Idempotency-Key': key } });
}
export function onboardingBusiness(config: Config & { tenantId: string }, signal?: AbortSignal) {
  return request<OnboardingBusiness>(config, 'business', { signal });
}
export function onboardingCosts(config: Config & { tenantId: string }, signal?: AbortSignal) {
  return request<OnboardingCosts>(config, 'costs', { signal });
}
