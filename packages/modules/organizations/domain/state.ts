// Máquina de estados del tenant (SPEC §6/§9): las transiciones inválidas se
// rechazan aquí, en dominio, sin tocar la base.
export const TENANT_STATES = [
  'trial',
  'active',
  'past_due',
  'read_only',
  'suspended',
  'deleted',
] as const;
export type TenantState = (typeof TENANT_STATES)[number];

const TRANSITIONS: Record<TenantState, TenantState[]> = {
  trial: ['active', 'read_only', 'deleted'],
  // `read_only` desde `active` es la CANCELACIÓN (SPEC §6): el negocio se
  // va, sus datos quedan y no sale nada. En el diagrama ese camino terminaba
  // en `[*]` sin decir dónde, y por eso faltaba acá.
  active: ['past_due', 'read_only', 'deleted'],
  past_due: ['active', 'read_only'],
  read_only: ['active', 'suspended'],
  suspended: ['active', 'deleted'],
  deleted: [],
};

export function assertTransition(from: TenantState, to: TenantState): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Transición de tenant inválida: ${from} → ${to}`);
  }
}

/**
 * ¿Puede este tenant MANDAR un mensaje? (SPEC §6)
 *
 * La regla del impago está escrita con todas sus letras: en solo lectura
 * «se reciben mensajes, no se envían salvo respuestas manuales». Estaba
 * declarada en el SPEC y en el diagrama, y en el código no la aplicaba
 * nadie: el estado se escribía en `tenants` y el tenant seguía enviando
 * campañas igual que el día antes de dejar de pagar.
 *
 * Entra lo entrante SIEMPRE: la bandeja no se corta nunca.
 */
export function puedeEnviar(
  state: TenantState,
  initiatedByBusiness: boolean,
): { ok: true } | { ok: false; motivo: string } {
  if (state === 'suspended' || state === 'deleted') {
    return { ok: false, motivo: `La cuenta está ${state === 'deleted' ? 'eliminada' : 'suspendida'}: no salen mensajes.` };
  }
  if (state === 'read_only' && initiatedByBusiness) {
    return {
      ok: false,
      motivo: 'La cuenta está en solo lectura por impago: solo salen respuestas manuales.',
    };
  }
  return { ok: true };
}

export const ONBOARDING_STATES = [
  'registered',
  'configured',
  'whatsapp_connected',
  'knowledge_added',
  'team_invited',
  'first_message',
  'active',
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/** El onboarding avanza; los pasos se pueden saltar pero no retroceder (SPEC §7). */
export function assertOnboardingAdvance(from: OnboardingState, to: OnboardingState): void {
  if (ONBOARDING_STATES.indexOf(to) <= ONBOARDING_STATES.indexOf(from)) {
    throw new Error(`El onboarding no retrocede: ${from} → ${to}`);
  }
}
