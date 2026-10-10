import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import { withTenant } from '@iaxti/db';
import { findAccountById } from '@iaxti/module-channels';
import type { ChannelAccountRef } from '@iaxti/module-channels';
import { contactoPorTelefono, normalizePhone, tipoDeLinea } from '@iaxti/module-crm';
import {
  bandejaSettings,
  enSilencio,
  isWithinWindow,
  ventanaDelContacto,
} from '@iaxti/module-conversations';
import type { Channel } from '@iaxti/module-conversations';
import { getTenant, getTenantSettings, puedeEnviar } from '@iaxti/module-organizations';
import { canReceiveBusinessInitiated } from '@iaxti/module-crm';
import { deliverOutbound, esPermanente, isBusinessPaused } from '@iaxti/module-whatsapp';

/**
 * Probar el envío de un canal, por el camino real (#587).
 *
 * ## Por qué existe
 *
 * Lino dijo tres veces «no puedo enviar mensajes desde la bandeja» y no se le
 * pudo contestar ninguna. El diagnóstico que había (#434, #591) revisa la
 * CONFIGURACIÓN —cuenta, credencial, webhook, emisor, calidad, plantillas,
 * silencio— y **nada intentaba enviar**. Así que la única forma de saber por
 * cuál de los caminos moría un envío era tener las credenciales y mirar la cola
 * a mano.
 *
 * Eso no es una comodidad que falta: es la diferencia entre «no funciona» y
 * «falta el emisor en la cuenta», y esa diferencia costaba una sesión entera.
 *
 * ## Por qué vive acá y no en un módulo
 *
 * Porque cruza cinco: `organizations` (el estado del tenant), `crm` (el
 * consentimiento), `conversations` (la ventana y el silencio), `channels` (la
 * cuenta) y `whatsapp` (el despacho). Ningún módulo puede orquestar eso sin
 * importar a los otros, que es justo lo que la regla de fronteras prohíbe.
 * `apps/api` es la raíz de composición: acá sí se pueden juntar contratos.
 *
 * No va en el controlador porque un controlador no lleva lógica de negocio, y
 * esto es casi puro negocio.
 *
 * ## Las reglas se aplican, no se saltan
 *
 * Una prueba de conexión la inicia el NEGOCIO, así que le corresponde todo lo
 * que le corresponde a un mensaje iniciado por el negocio: consentimiento,
 * ventana de 24 h, pausa por calidad y horario de silencio. Saltárselas para
 * que «la prueba funcione» sería construir una puerta para mandarle un mensaje
 * a alguien que pidió no recibirlos.
 *
 * Y el rechazo por esas reglas **ya es el diagnóstico**: si el número no
 * escribió en 24 h, eso es casi siempre la razón real de que no salga nada.
 *
 * El silencio se RECHAZA y no se difiere: diferir una prueba es dejar a alguien
 * esperando un resultado que va a llegar a las ocho de la mañana.
 */

/** Los motivos por los que una prueba no sale, cada uno con su nombre. */
export type MotivoDeRechazo =
  | 'CANAL_NO_ACTIVO'
  | 'TENANT_SIN_ENVIO'
  | 'SIN_CONSENTIMIENTO'
  | 'VENTANA_CERRADA'
  | 'CALIDAD_PAUSADA'
  | 'HORARIO_DE_SILENCIO'
  | 'CANAL_RECHAZO'
  | 'PROVEEDOR_INTERMITENTE'
  | 'NO_ES_MOVIL';

export interface ResultadoDePrueba {
  ok: boolean;
  /** `null` cuando salió. */
  motivo: MotivoDeRechazo | null;
  /** Lo que se le muestra a quien administra el canal. */
  mensaje: string;
  /**
   * El cuerpo crudo del proveedor, solo cuando lo hay.
   *
   * Va a ESTA pantalla y no a la bandeja: es la contraparte de #556 — el
   * vendedor lee la frase humana, quien conecta el canal necesita el cuerpo del
   * error. Y por eso esta ruta pide `channels.manage`.
   */
  detalle?: string;
  /** El id que devolvió el proveedor, cuando el mensaje salió. */
  providerMessageId?: string;
}

/**
 * El texto que se manda. Dice que es una prueba y de dónde viene: quien lo
 * recibe tiene que entender por qué le llegó, y el número de un negocio
 * mandando «test» a un cliente es peor que no probar.
 */
export const CUERPO_DE_PRUEBA =
  'Prueba de conexión de IAxTi. Si recibes este mensaje, el canal de tu negocio está ' +
  'enviando bien. No hace falta que respondas.';

export interface DepsDePrueba {
  pool: Pool;
  redis: IORedis | null;
  /** Para poder probar el camino sin tocar el proveedor. */
  despachar?: typeof deliverOutbound;
  ahora?: Date;
}

export async function probarEnvio(
  deps: DepsDePrueba,
  input: { tenantId: string; accountId: string; telefono: string; requestId?: string },
): Promise<ResultadoDePrueba> {
  const telefono = normalizePhone(input.telefono);
  /**
   * Las comprobaciones van en la transacción; el envío, afuera.
   *
   * Todo lo que decide si la prueba puede salir necesita la base, así que se
   * hace adentro de un `withTenant`. El despacho NO: es una llamada HTTP al
   * proveedor que puede tardar segundos, y dejar una transacción abierta
   * mientras se espera por la red es quedarse con una conexión del pool —y con
   * los candados que tenga tomados— por todo ese rato. Con la base a 64 ms de
   * distancia (#711) eso se nota.
   *
   * Por eso esto devuelve «el rechazo» o «lo que hace falta para despachar», y
   * el envío ocurre después, ya fuera.
   */
  const previo: ResultadoDePrueba | { despachable: ChannelAccountRef } = await withTenant(
    deps.pool,
    input.tenantId,
    async (client) => {
      const cuenta = await findAccountById(client, input.accountId);
      if (!cuenta || cuenta.tenantId !== input.tenantId) {
        // Que no exista se trata como canal no activo y no como 404: esta
        // función la llama una ruta que ya comprobó el tenant, así que llegar acá
        // sin cuenta es un canal que se desconectó entremedio.
        return {
          ok: false,
          motivo: 'CANAL_NO_ACTIVO' as const,
          mensaje: 'No encontramos ese canal. Puede que se haya desconectado.',
        };
      }
      if (!['active', 'degraded'].includes(cuenta.state)) {
        return {
          ok: false,
          motivo: 'CANAL_NO_ACTIVO' as const,
          mensaje: `Este canal está ${cuenta.state}: así no sale ningún mensaje. Revisa su conexión antes de probar.`,
        };
      }

      // El estado del tenant manda (SPEC §6), y se mira primero: de una cuenta
      // suspendida no sale nada, y de una en solo lectura por impago solo salen
      // respuestas manuales — una prueba la inicia el negocio.
      const tenant = await getTenant(client, input.tenantId);
      const permiso = puedeEnviar(tenant.state, true);
      if (!permiso.ok) {
        return { ok: false, motivo: 'TENANT_SIN_ENVIO' as const, mensaje: permiso.motivo };
      }

      // WhatsApp solo llega a móviles (#582). Un fijo es un teléfono VÁLIDO al
      // que este canal no llega, así que el mensaje lo dice así y no «teléfono
      // inválido» — que mandaría a corregir un número que está bien escrito.
      //
      // Solo corta con un `fijo` SEGURO. `no_se` pasa: fuera de Chile el tipo
      // no se puede saber, y bloquear por una duda es bloquear a un cliente de
      // verdad.
      if (cuenta.kind === 'whatsapp' && tipoDeLinea(telefono) === 'fijo') {
        return {
          ok: false,
          motivo: 'NO_ES_MOVIL' as const,
          mensaje:
            `${telefono} es un número fijo, y WhatsApp solo llega a celulares. El número está bien ` +
            'escrito: lo que no se puede es mandarle un WhatsApp.',
        };
      }

      const contacto = await contactoPorTelefono(client, { tenantId: input.tenantId, phone: telefono });
      if (!contacto) {
        // Y esto YA es el diagnóstico más probable: a un número que nunca nos
        // escribió no se le puede mandar nada iniciado por el negocio.
        return {
          ok: false,
          motivo: 'VENTANA_CERRADA' as const,
          mensaje:
            `${telefono} no está en tus contactos, así que nunca te escribió. La ventana de 24 h del ` +
            'canal está cerrada: pídele que te escriba y vuelve a probar con ese número.',
        };
      }
      if (contacto.optedOutAt || !(await canReceiveBusinessInitiated(client, input.tenantId, contacto.id))) {
        return {
          ok: false,
          motivo: 'SIN_CONSENTIMIENTO' as const,
          mensaje:
            'Ese contacto no tiene consentimiento vigente para recibir mensajes iniciados por el ' +
            'negocio. Prueba con un número que te haya escrito.',
        };
      }

      const ventana = await ventanaDelContacto(client, {
        tenantId: input.tenantId,
        contactId: contacto.id,
        channel: cuenta.kind as Channel,
      });
      if (!isWithinWindow(cuenta.kind as Channel, ventana?.lastInboundAt ?? null, deps.ahora)) {
        return {
          ok: false,
          motivo: 'VENTANA_CERRADA' as const,
          mensaje:
            'Pasaron más de 24 horas desde su último mensaje: la ventana del canal está cerrada y solo ' +
            'entraría una plantilla aprobada. Pídele que te escriba y vuelve a probar.',
        };
      }

      const pausa = await isBusinessPaused(client, input.tenantId, cuenta.id);
      if (pausa) {
        return { ok: false, motivo: 'CALIDAD_PAUSADA' as const, mensaje: pausa };
      }

      const settings = bandejaSettings(await getTenantSettings(client, input.tenantId));
      if (enSilencio(settings.silencio, deps.ahora)) {
        return {
          ok: false,
          motivo: 'HORARIO_DE_SILENCIO' as const,
          mensaje:
            'Estás en horario de silencio: nada iniciado por el negocio sale ahora. La prueba no se ' +
            'difiere a propósito — vuelve a intentarla dentro del horario.',
        };
      }

      if (!deps.redis && !deps.despachar) {
        return {
          ok: false,
          motivo: 'PROVEEDOR_INTERMITENTE' as const,
          mensaje: 'Este ambiente no tiene Redis configurado, y el despacho lo necesita para el tope por número.',
        };
      }

      return { despachable: cuenta as ChannelAccountRef };
    },
  );

  if (!('despachable' in previo)) return previo;
  const cuenta: ChannelAccountRef = previo.despachable;

  const despachar = deps.despachar ?? deliverOutbound;
  try {
    // Por `deliverOutbound` y NO por un `fetch` propio: una prueba que no usa
    // el camino real no prueba nada. El mismo adaptador, el mismo emisor, la
    // misma credencial y el mismo tope por número que un mensaje de verdad.
    const res = await despachar(
      cuenta,
      {
        tenantId: input.tenantId,
        // No hay mensaje en la base: esta prueba no entra a la bandeja. El
        // rastro queda en `audit_log`, que es donde se pregunta después quién
        // probó y a qué número.
        messageId: `prueba-${input.accountId}`,
        channelAccountId: cuenta.id,
        to: telefono,
        type: 'texto',
        body: CUERPO_DE_PRUEBA,
        initiatedByBusiness: true,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
      deps.redis as IORedis,
    );
    return {
      ok: true,
      motivo: null,
      mensaje: `Salió. El proveedor lo aceptó y debería llegar a ${telefono} en segundos.`,
      providerMessageId: res.providerMessageId,
    };
  } catch (err) {
    if (esPermanente(err)) {
      return {
        ok: false,
        motivo: 'CANAL_RECHAZO' as const,
        mensaje: err.message,
        ...(err.detalle ? { detalle: err.detalle } : {}),
      };
    }
    // Lo intermitente se nombra distinto a propósito: un 429 o un 500 del
    // proveedor se reintenta y no es un canal mal configurado. Decirle «tu
    // canal rechazó el mensaje» mandaría a revisar lo que está bien.
    return {
      ok: false,
      motivo: 'PROVEEDOR_INTERMITENTE' as const,
      mensaje:
        'El proveedor no contestó bien, pero es algo temporal: un mensaje de verdad se reintenta ' +
        'solo. Prueba de nuevo en un minuto.',
      detalle: (err as Error).message,
    };
  }
}
