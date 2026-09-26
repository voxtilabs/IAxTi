import type { PoolClient } from 'pg';
import { connectWhatsAppNumber, type WhatsAppNumber } from './numbers';
import { ZAVU_API_BASE_DEFAULT } from './zavu';
import type { ChannelAccountRef, ChannelKind } from '@iaxti/module-channels';

// Conectar un canal de Zavu a un tenant (#42, #56). Existe para que el día
// que llegue la credencial esto sea UN comando y no una lista de pasos que
// alguien va a hacer a medias a las once de la noche.
//
// Todo lo decidible se decide acá y se puede probar sin red: qué sender
// sirve, qué webhook registrar, qué falta. La parte que habla con Zavu entra
// inyectada.

export interface SenderZavu {
  id: string;
  name: string;
  channels: string[];
  isDefault?: boolean;
  webhook?: { url?: string | null; signatureVersion?: string | null; active?: boolean };
}

export type LlamarZavu = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>;

/** Cliente mínimo contra la API de Zavu; se inyecta en los tests. */
export function clienteZavu(apiKey: string, apiBase = process.env.ZAVU_API_BASE ?? ZAVU_API_BASE_DEFAULT): LlamarZavu {
  return async (path, init = {}) => {
    const res = await fetch(`${apiBase}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) {
      const motivo = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Zavu respondió HTTP ${res.status} en ${path}. ${motivo}`.trim());
    }
    return res.json();
  };
}

export interface ProyectoZavu {
  project: { id: string; name: string; isSubAccount?: boolean };
  apiKey?: { id: string };
  /** La API lo dice; el prefijo del token es solo una pista. */
  isTestMode: boolean;
}

/**
 * Qué llave es esta, según la API y no según su prefijo. `GET /v1/me`
 * responde `isTestMode`, y eso es lo que decide si puede tocar un ambiente.
 */
export async function quienSoy(llamar: LlamarZavu): Promise<ProyectoZavu> {
  return (await llamar('/me')) as ProyectoZavu;
}

/**
 * ¿Sirve esta llave para este ambiente? (#593)
 *
 * La regla de fondo sigue siendo la misma: en producción se manda desde el número
 * real del negocio a clientes reales, y una prueba mal apuntada les escribe de
 * verdad — eso no se deshace con un rollback. Se decide con `isTestMode` de la
 * API y no con el prefijo del token: un token se puede renombrar, lo que la API
 * responde no.
 *
 * Lo que cambió es la SALIDA. Antes la única forma de conectar una llave de
 * producción fuera de producción era declarar `IAXTI_ENV=production`, y eso está
 * mal porque `IAXTI_ENV` no es solo para esto: lo lee la comprobación de
 * aislamiento por tenant en `rls.ts`, el `environment` de Sentry y la generación
 * de links de pago. Para hacer algo legítimo había que mentirle al resto del
 * sistema, y la mentira no se queda quieta.
 *
 * Así que ahora son dos preguntas separadas:
 *
 *  1. ¿En qué ambiente corro? → `IAXTI_ENV`, y nadie lo toca para conectar.
 *  2. ¿Puede esta instalación mandar mensajes de verdad? → `enviosReales`, una
 *     declaración propia y explícita.
 *
 * Probar con un número real es una decisión defendible —un WhatsApp de verdad se
 * comporta distinto que un simulador— y el producto tiene que soportarla sin
 * obligar a falsear el ambiente. Lo que NO puede es pasar desapercibida: quien
 * la declara lo hace a propósito, y el canal queda marcado para que cualquiera
 * que mire lo vea.
 */
export function llaveSirveParaAmbiente(
  proyecto: ProyectoZavu,
  ambiente: string | undefined,
  enviosReales = false,
): { ok: true; reales: boolean } | { ok: false; motivo: string } {
  const esProduccion = ambiente === 'production';
  if (esProduccion && proyecto.isTestMode) {
    // Este lado no se negocia: en producción una llave de prueba significa que
    // los clientes del negocio no reciben nada, y nadie se enteraría hasta que
    // alguien reclame. No hay declaración que lo haga aceptable.
    return {
      ok: false,
      motivo:
        'Esta es una llave de PRUEBA y el ambiente es producción: los mensajes no saldrían de verdad.',
    };
  }
  if (!esProduccion && !proyecto.isTestMode) {
    if (!enviosReales) {
      return {
        ok: false,
        motivo:
          `Esta es una llave de PRODUCCIÓN y el ambiente es "${ambiente ?? 'sin declarar'}". ` +
          'Conectarla acá manda mensajes reales a clientes reales desde el número del negocio.\n' +
          'Si es lo que quieres —probar contra un número de verdad—, declara ' +
          'ZAVU_ENVIOS_REALES=1 y queda registrado en el canal.\n' +
          'Si no, usa la llave de prueba. Lo que NO hay que hacer es declarar ' +
          'IAXTI_ENV=production: eso le miente al aislamiento por tenant, a Sentry y a ' +
          'los links de pago.',
      };
    }
    // Declarado a propósito: pasa, y el llamador se encarga de que quede visible.
    return { ok: true, reales: true };
  }
  return { ok: true, reales: esProduccion };
}

/**
 * De todos los senders del proyecto, cuál sirve para este canal. Con varios,
 * no se adivina: se listan y se pide elegir. Conectar el número equivocado
 * al tenant equivocado es de las cosas más caras de deshacer.
 */
export function elegirSender(
  senders: SenderZavu[],
  kind: ChannelKind,
  senderIdPedido?: string,
): { sender: SenderZavu } | { error: string; candidatos: SenderZavu[] } {
  const sirven = senders.filter((s) => s.channels?.includes(kind));
  if (senderIdPedido) {
    const exacto = sirven.find((s) => s.id === senderIdPedido);
    if (exacto) return { sender: exacto };
    return {
      error: `El sender ${senderIdPedido} no existe o no tiene el canal ${kind} encendido.`,
      candidatos: sirven,
    };
  }
  if (sirven.length === 0) {
    return {
      error: `Ningún sender del proyecto tiene ${kind}. Conecta la cuenta en Zavu primero (partner invitation) y vuelve a correr esto.`,
      candidatos: senders,
    };
  }
  if (sirven.length > 1) {
    return {
      error: `Hay ${sirven.length} senders con ${kind}: elige uno con --sender. No adivino cuál es el del negocio.`,
      candidatos: sirven,
    };
  }
  return { sender: sirven[0] };
}

/** La URL del webhook de un tenant: la misma forma que ya recibe #41. */
export function urlWebhook(baseUrl: string, accountId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/webhooks/channels/${accountId}`;
}

/** Los eventos que el producto necesita. Pedir de más es ruido que igual se descarta. */
export const EVENTOS_WEBHOOK = [
  'message.inbound',
  'conversation.new',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'template.status_changed',
] as const;

export interface ResultadoConexion {
  number: WhatsAppNumber;
  account: ChannelAccountRef;
  senderId: string;
  webhookUrl: string;
  /** El secreto solo se ve UNA vez: va al env, nunca a la base. */
  webhookSecret: string | null;
  avisos: string[];
}

/**
 * Conecta el sender al tenant: crea la cuenta de canal y el número, y deja
 * el webhook apuntando a nuestra API. La credencial se guarda POR REFERENCIA
 * (el NOMBRE de la variable), jamás el valor.
 */
export async function conectarSender(
  client: PoolClient,
  input: {
    tenantId: string;
    nombre: string;
    sender: SenderZavu;
    baseUrl: string;
    credentialRef: string;
    webhookSecretRef: string;
    llamar: LlamarZavu;
    kind?: ChannelKind;
    /** Si esta conexión manda de verdad (#593). Se guarda en la cuenta. */
    enviosReales?: boolean;
  },
): Promise<ResultadoConexion> {
  const avisos: string[] = [];
  const { number, account } = await connectWhatsAppNumber(client, {
    tenantId: input.tenantId,
    name: input.nombre,
    senderId: input.sender.id,
    displayPhone: input.sender.name,
    credentialRef: input.credentialRef,
    webhookSecretRef: input.webhookSecretRef,
    ...(input.enviosReales ? { enviosReales: true } : {}),
  });

  const webhookUrl = urlWebhook(input.baseUrl, account.id);
  await input.llamar(`/senders/${input.sender.id}`, {
    method: 'PATCH',
    body: {
      webhookUrl,
      webhookEvents: [...EVENTOS_WEBHOOK],
      webhookActive: true,
    },
  });

  // El secreto se rota para tenerlo: Zavu solo lo muestra al crearlo.
  let webhookSecret: string | null = null;
  try {
    const rotado = (await input.llamar(`/senders/${input.sender.id}/webhook-secret/regenerate`, {
      method: 'POST',
    })) as { secret?: string };
    webhookSecret = rotado?.secret ?? null;
  } catch (err) {
    avisos.push(
      `No pude rotar el secreto del webhook (${(err as Error).message}). Sácalo del panel y guárdalo como ${input.webhookSecretRef}.`,
    );
  }
  if (!webhookSecret) {
    avisos.push(
      `Sin el secreto en ${input.webhookSecretRef}, TODO webhook entrante se rechaza por firma inválida. Es el paso que no se puede saltar.`,
    );
  }
  if (input.sender.webhook?.signatureVersion === 'v1') {
    avisos.push(
      'Este sender firma con el esquema v1 (antiguo). El adaptador lo acepta, pero conviene moverlo a v2 en Zavu.',
    );
  }

  return { number, account, senderId: input.sender.id, webhookUrl, webhookSecret, avisos };
}

/**
 * Qué dice el proveedor del emisor que tenemos guardado (#591).
 *
 * El diagnóstico daba el paso del emisor por bueno con que hubiera un string en
 * `config.senderId`. Pero el emisor vive allá: puede haber dejado de existir, o
 * seguir existiendo y ya no tener el canal —Meta suspendió la cuenta, venció la
 * autorización, alguien la desconectó—. La documentación de Zavu es explícita:
 * el array `channels` del sender es la fuente de verdad, y vacío significa que
 * no puede mandar nada.
 *
 * Devuelve `null` cuando NO SE PUDO PREGUNTAR, que es distinto de «no existe»:
 * sin credencial o con el proveedor caído no sabemos nada, y el diagnóstico
 * tiene un estado para eso. Confundirlos es lo que tenía este paso en verde
 * mientras no salía ni un mensaje.
 */
export async function emisorDelProveedor(
  llamar: LlamarZavu,
  senderId: string,
): Promise<{ existe: boolean; canales: string[] } | null> {
  try {
    // La API pagina con `{items, nextCursor}`; se aceptan las tres formas que
    // ya tolera el script de conexión, por la misma razón que él.
    const respuesta = (await llamar('/senders')) as
      | SenderZavu[]
      | { items?: SenderZavu[]; data?: SenderZavu[] };
    const senders = Array.isArray(respuesta)
      ? respuesta
      : (respuesta.items ?? respuesta.data ?? []);
    const suyo = senders.find((s) => s.id === senderId);
    if (!suyo) return { existe: false, canales: [] };
    return { existe: true, canales: suyo.channels ?? [] };
  } catch {
    // No se pudo preguntar. El motivo no se propaga a propósito: puede traer
    // la credencial en el mensaje del error.
    return null;
  }
}
