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
  active: ['past_due', 'deleted'],
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
