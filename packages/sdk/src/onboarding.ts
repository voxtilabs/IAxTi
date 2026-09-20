import { onboardingOperation } from './onboarding-route.generated';

export interface OnboardingProgress {
  estadoRegistrado: string;
  completo: boolean;
  siguiente: string | null;
  desfase: string[];
  pasos: Array<{
    id: string; titulo: string; ayuda: string; opcional: boolean; hecho: boolean;
    bloqueado: boolean; ruta: string | null; detalle: string | null; fuente: 'verificado' | 'historial';
  }>;
}

/** Sin permiso de configuración, el panel de puesta en marcha no se muestra. */
export async function getOnboarding(config: { apiUrl: string; token: string; tenantId: string }, signal?: AbortSignal): Promise<OnboardingProgress | null> {
  const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${onboardingOperation.path}`, {
    method: onboardingOperation.method,
    headers: { Authorization: `Bearer ${config.token}`, 'X-Tenant-Id': config.tenantId }, signal,
  });
  if (response.status === 403) return null;
  if (!response.ok) throw new Error('No pudimos cargar tu avance. Intenta actualizarlo.');
  return response.json() as Promise<OnboardingProgress>;
}
