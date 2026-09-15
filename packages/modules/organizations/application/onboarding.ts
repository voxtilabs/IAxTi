import type { PoolClient } from 'pg';
import type { Consumer, EventEnvelope } from '@iaxti/core';
import { ONBOARDING_STATES, type OnboardingState } from '../domain/state';
import { advanceOnboarding, getTenant } from './tenants';

/**
 * El onboarding avanza solo, con lo que de verdad pasa (SPEC §7).
 *
 * La máquina existía entera —los pasos, el orden, la regla de que se pueden
 * saltar pero no retroceder— y `advanceOnboarding` no lo llamaba NADIE. En
 * todo el código aparecía dos veces: la definición y la línea del contrato
 * que la exporta. O sea que todos los tenants se quedaban en `registered`
 * para siempre, y la pantalla que muestra "cómo vas" mostraba lo mismo el
 * primer día que el día ochenta.
 *
 * Acá se engancha a los eventos que ya se publican. No inventa pasos: un
 * paso avanza cuando ocurrió la cosa que ese paso nombra.
 */
const POR_EVENTO: Record<string, OnboardingState> = {
  'tenant.settings_changed': 'configured',
  'channel.connected': 'whatsapp_connected',
  'knowledge.source_added': 'knowledge_added',
  'user.invited': 'team_invited',
  'message.sent': 'first_message',
};

/**
 * Avanza al paso que corresponde, si eso es avanzar.
 *
 * Los pasos llegan en cualquier orden —un negocio puede invitar a su equipo
 * antes de conectar el número— y el dominio ya prohíbe retroceder. Acá se
 * traduce esa prohibición a "no hacer nada", que es lo correcto para un
 * consumidor de eventos: no es un fallo que el evento llegue tarde.
 */
export async function avanzarPorEvento(
  client: PoolClient,
  tenantId: string,
  paso: OnboardingState,
): Promise<boolean> {
  const tenant = await getTenant(client, tenantId).catch(() => null);
  if (!tenant) return false;
  const actual = ONBOARDING_STATES.indexOf(tenant.onboardingState);
  const destino = ONBOARDING_STATES.indexOf(paso);
  if (destino <= actual) return false; // ya pasó por ahí: nada que hacer
  await advanceOnboarding(client, tenantId, paso);
  return true;
}

export function onboardingConsumers(): Consumer[] {
  return Object.entries(POR_EVENTO).map(([event, paso]) => ({
    name: `organizations.onboarding.${event}`,
    moduleId: 'organizations',
    event,
    handler: async (envelope: EventEnvelope, client: PoolClient) => {
      await avanzarPorEvento(client, envelope.tenantId, paso);
    },
  }));
}
