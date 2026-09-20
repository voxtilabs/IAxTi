import type { PoolClient } from 'pg';
import type { Consumer, EventEnvelope } from '@iaxti/core';
import { ONBOARDING_STATES, type OnboardingState } from '../domain/state';
import { PASOS } from '../domain/onboarding-pasos';
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
 * Hay eventos que solo cuentan para el paso si vienen del canal correcto.
 *
 * `channel.connected` se publica para CUALQUIER canal: webchat, simulador,
 * Instagram, Messenger. Y el paso se llama `whatsapp_connected`. O sea que
 * el tenant que prende el simulador —que es exactamente lo que uno hace
 * para probar el producto sin número, y lo que hace nuestra propia demo—
 * se saltaba el paso de WhatsApp sin conectar WhatsApp. Como los pasos no
 * retroceden, quedaba saltado para siempre: el flujo guiado no se lo vuelve
 * a pedir nunca y el negocio nunca conecta su número.
 */
const CANAL_DEL_PASO: Record<string, string> = {
  'channel.connected': 'whatsapp',
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
      const exigido = CANAL_DEL_PASO[event];
      if (exigido) {
        const kind = (envelope.payload as { kind?: string } | undefined)?.kind;
        if (kind !== exigido) return;
      }
      await avanzarPorEvento(client, envelope.tenantId, paso);
    },
  }));
}

// ── Dónde va el negocio, de verdad (#56) ────────────────────────────────

export interface EstadoDePaso {
  id: OnboardingState;
  titulo: string;
  ayuda: string;
  opcional: boolean;
  hecho: boolean;
  /** Lo que se encontró al mirar: "2 personas invitadas", "sin catálogo". */
  detalle: string | null;
  /** El módulo que lo resuelve está apagado para este tenant. */
  bloqueado: boolean;
  /** De dónde salió `hecho`: lo que hay hoy, o el registro histórico. */
  fuente: 'verificado' | 'historial';
  /**
   * Dónde se resuelve, en el producto. Viene del catálogo de pasos: el
   * módulo declara dónde está su cosa, igual que el `nav` de su manifiesto,
   * en vez de una tabla paralela en la pantalla que se desincroniza sola.
   */
  ruta: string | null;
}

export interface EstadoOnboarding {
  /** La columna: hasta dónde llegó alguna vez. No retrocede. */
  estadoRegistrado: OnboardingState;
  pasos: EstadoDePaso[];
  /** El primer paso obligatorio que falta. `null` si no falta ninguno. */
  siguiente: OnboardingState | null;
  completo: boolean;
  /**
   * La columna dice más de lo que hay. Pasa cuando un evento marcó un paso
   * que hoy no se sostiene: el número se desconectó, o el paso se saltó por
   * el motivo equivocado. Sin esto, el flujo guiado le muestra al negocio un
   * check verde sobre algo que no está.
   */
  desfase: string[];
}

/**
 * Cada verificador responde por SU paso mirando su propio módulo.
 *
 * Va inyectado porque `organizations` no puede consultar las tablas de otro
 * módulo (regla de arquitectura): quien arma esto es la app, que sí conoce
 * los contratos. Un paso sin verificador cae al historial de la columna, y
 * lo dice en `fuente` en vez de hacerlo pasar por comprobado.
 */
export type Verificador = () => Promise<{ hecho: boolean; detalle?: string | null }>;

export interface OnboardingDeps {
  /** Los módulos activos para este tenant. Un paso de un módulo apagado no aplica. */
  activeModules: string[];
  verificadores?: Partial<Record<OnboardingState, Verificador>>;
}

export async function onboardingStatus(
  client: PoolClient,
  tenantId: string,
  deps: OnboardingDeps,
): Promise<EstadoOnboarding> {
  const tenant = await getTenant(client, tenantId);
  const registrado = tenant.onboardingState;
  const indiceRegistrado = ONBOARDING_STATES.indexOf(registrado);
  const activos = new Set(deps.activeModules);

  const pasos: EstadoDePaso[] = [];
  const desfase: string[] = [];
  for (const def of PASOS) {
    const bloqueado = def.modulo !== null && !activos.has(def.modulo);
    const enHistorial = ONBOARDING_STATES.indexOf(def.id) <= indiceRegistrado;
    const verificador = bloqueado ? undefined : deps.verificadores?.[def.id];

    let hecho = enHistorial;
    let detalle: string | null = null;
    let fuente: EstadoDePaso['fuente'] = 'historial';
    if (verificador) {
      // Lo que hay MANDA sobre lo que la columna recuerda. La columna no
      // retrocede por diseño, así que un paso marcado de más se queda
      // marcado para siempre y el flujo guiado deja de pedirlo.
      const r = await verificador().catch(() => null);
      if (r) {
        hecho = r.hecho;
        detalle = r.detalle ?? null;
        fuente = 'verificado';
        // Desfase SOLO en los obligatorios, y la razón no es de estilo: la
        // columna es un ORDINAL, y los pasos se pueden saltar. Que el
        // registro haya pasado por encima de "sube tu catálogo" no dice que
        // se hizo — dice que se avanzó más allá. En un opcional eso es lo
        // normal, y avisarlo sería inventarle un problema al negocio.
        //
        // En un obligatorio igual vale la pena decirlo: o se hizo y hoy no
        // está, o se saltó por el motivo equivocado. Las dos cosas son algo
        // que el flujo guiado tiene que volver a pedir, y con la columna
        // sola no lo pediría nunca.
        if (enHistorial && !r.hecho && !def.opcional) {
          desfase.push(`"${def.titulo}" figura como hecho y hoy no está: ${detalle ?? 'no encontramos nada'}.`);
        }
      }
    }
    pasos.push({
      id: def.id,
      titulo: def.titulo,
      ayuda: def.ayuda,
      opcional: def.opcional,
      hecho,
      detalle,
      bloqueado,
      fuente,
      ruta: def.ruta,
    });
  }

  // El siguiente es el primer OBLIGATORIO que falta y se puede hacer: un
  // paso bloqueado por módulo apagado no es algo que el negocio pueda
  // resolver, y ponérselo como "lo que sigue" es mandarlo a una pared.
  const siguiente =
    pasos.find((p) => !p.opcional && !p.hecho && !p.bloqueado)?.id ?? null;
  const completo = pasos.every((p) => p.opcional || p.hecho || p.bloqueado);

  return { estadoRegistrado: registrado, pasos, siguiente, completo, desfase };
}
