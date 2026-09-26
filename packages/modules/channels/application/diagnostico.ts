import type { PoolClient } from 'pg';
import { rastroDeWebhook, type RastroDeWebhook } from './rastro';
import { findAccountById } from './accounts';
import type { ChannelAccountRef } from '../domain/port';

/**
 * Por qué no llegan los mensajes (#434).
 *
 * Son cuatro causas que se arreglan en lugares distintos y desde adentro se
 * veían todas iguales: el webhook apunta a otra parte, el secreto no
 * corresponde al emisor, la cuenta está desconectada, o simplemente nadie
 * escribió. Esto las separa y dice qué hacer con cada una.
 *
 * El orden importa: se revisa de afuera hacia adentro, como se diagnostica
 * de verdad. Si el webhook nunca llegó, que falte la plantilla es
 * irrelevante — y mostrar seis problemas cuando hay uno hace que nadie
 * arregle ninguno.
 */
export type EstadoDelPaso = 'bien' | 'mal' | 'atencion' | 'desconocido';

export interface PasoDelDiagnostico {
  id: string;
  titulo: string;
  estado: EstadoDelPaso;
  /** Qué se vio. Nunca el cuerpo de un mensaje ni una credencial. */
  detalle: string;
  /** Qué hacer. Vacío cuando no hay nada que hacer. */
  queHacer?: string;
}

export interface Diagnostico {
  accountId: string;
  kind: string;
  /** El primer paso que está mal. `null` si todo está bien. */
  problema: string | null;
  pasos: PasoDelDiagnostico[];
}

const MINUTO = 60_000;

function haceCuanto(cuando: Date, ahora: Date): string {
  const ms = ahora.getTime() - cuando.getTime();
  if (ms < MINUTO) return 'hace menos de un minuto';
  if (ms < 60 * MINUTO) return `hace ${Math.round(ms / MINUTO)} minutos`;
  if (ms < 48 * 60 * MINUTO) return `hace ${Math.round(ms / (60 * MINUTO))} horas`;
  return `hace ${Math.round(ms / (24 * 60 * MINUTO))} días`;
}

export async function diagnosticarCanal(
  client: PoolClient,
  input: { tenantId: string; accountId: string; ahora?: Date },
  deps: {
    /** ¿Existe la variable de entorno con ese nombre? El VALOR no se mira. */
    hayCredencial: (ref: string | null) => boolean;
    /** Cuántas plantillas aprobadas tiene el negocio. Solo WhatsApp. */
    plantillasAprobadas?: () => Promise<number>;
    /** ¿Hay un número conectado? Solo WhatsApp. */
    numeroConectado?: () => Promise<boolean>;
    /** Cuántos mensajes entraron en las últimas 24 h. */
    entrantesRecientes?: () => Promise<number>;
    /**
     * Qué dice el PROVEEDOR del emisor guardado (#591).
     *
     * Hasta ahora este paso se daba por bueno con que hubiera un string en
     * `config.senderId`. Pero el emisor vive en el proveedor, no acá: puede
     * haber dejado de existir, o seguir existiendo y ya no tener WhatsApp
     * —Meta suspendió la cuenta, venció el token, alguien la desconectó—. El
     * array `channels` del sender es la fuente de verdad, y vacío significa
     * que no puede mandar nada.
     *
     * `null` = no se pudo preguntar (sin credencial, proveedor caído). Eso NO
     * es «está bien»: es «no sabemos», y tiene su propio estado.
     */
    emisorEnElProveedor?: () => Promise<{ existe: boolean; canales: string[] } | null>;
  },
): Promise<Diagnostico> {
  const ahora = input.ahora ?? new Date();
  const cuenta = await findAccountById(client, input.accountId);
  if (!cuenta || cuenta.tenantId !== input.tenantId) {
    throw new Error('No encontramos ese canal.');
  }
  const rastro = await rastroDeWebhook(client, input.tenantId, input.accountId);
  const pasos: PasoDelDiagnostico[] = [];

  pasos.push(pasoDeLaCuenta(cuenta));
  pasos.push(pasoDeLaCredencial(cuenta, deps.hayCredencial));
  pasos.push(pasoDelWebhook(rastro, ahora));
  // Después del webhook y no antes: el orden de este archivo va de afuera
  // hacia adentro, y si el webhook nunca llegó no hay conversación que
  // contestar — mandar a revisar el emisor sería el consejo equivocado.
  pasos.push(await pasoDelEmisor(cuenta, deps.emisorEnElProveedor));

  if (deps.numeroConectado) {
    const conectado = await deps.numeroConectado();
    pasos.push({
      id: 'numero',
      titulo: 'Número conectado',
      estado: conectado ? 'bien' : 'mal',
      detalle: conectado ? 'Hay un número conectado a esta cuenta.' : 'Ningún número quedó conectado.',
      ...(conectado ? {} : { queHacer: 'Termina la conexión del número con el proveedor.' }),
    });
  }
  if (deps.plantillasAprobadas) {
    const n = await deps.plantillasAprobadas();
    pasos.push({
      id: 'plantillas',
      titulo: 'Plantillas aprobadas',
      estado: n > 0 ? 'bien' : 'atencion',
      detalle:
        n > 0
          ? `${n} plantilla${n === 1 ? '' : 's'} aprobada${n === 1 ? '' : 's'}.`
          : 'Ninguna plantilla aprobada todavía.',
      // Atención y no error: se puede recibir y responder dentro de las 24 h
      // sin ninguna plantilla. Lo que no se puede es escribir primero.
      ...(n > 0
        ? {}
        : {
            queHacer:
              'Sin plantilla aprobada puedes responder dentro de las 24 horas, pero no escribir primero ' +
              'ni mandar recordatorios de cita.',
          }),
    });
  }
  if (deps.entrantesRecientes) {
    const n = await deps.entrantesRecientes();
    pasos.push({
      id: 'mensajes',
      titulo: 'Mensajes en la bandeja',
      estado: n > 0 ? 'bien' : 'desconocido',
      detalle:
        n > 0
          ? `${n} mensaje${n === 1 ? '' : 's'} entrante${n === 1 ? '' : 's'} en las últimas 24 horas.`
          : 'Ningún mensaje entrante en las últimas 24 horas.',
      // Sin queHacer a propósito: que nadie haya escrito NO es un problema,
      // y ponerle un remedio al silencio manda a arreglar lo que funciona.
    });
  }

  const roto = pasos.find((p) => p.estado === 'mal');
  return { accountId: cuenta.id, kind: cuenta.kind, problema: roto?.id ?? null, pasos };
}

function pasoDeLaCuenta(cuenta: ChannelAccountRef): PasoDelDiagnostico {
  if (cuenta.state === 'active') {
    return { id: 'cuenta', titulo: 'Canal activo', estado: 'bien', detalle: 'El canal está activo.' };
  }
  if (cuenta.state === 'connecting') {
    // No es un fallo: la conexión quedó a medias. Y NO tapa lo de abajo,
    // porque una cuenta a medio conectar igual recibe webhooks — el paso
    // que importa sigue siendo si llegan.
    return {
      id: 'cuenta',
      titulo: 'Canal activo',
      estado: 'atencion',
      detalle: 'La conexión quedó a medias: el canal nunca pasó a activo.',
      queHacer: 'Termina de conectarlo. Mientras tanto recibe, pero no está confirmado.',
    };
  }
  if (cuenta.state === 'degraded') {
    return {
      id: 'cuenta',
      titulo: 'Canal activo',
      estado: 'atencion',
      detalle: 'El canal está degradado: recibe, pero el proveedor reportó problemas.',
      queHacer: 'Revisa la calidad del número más abajo.',
    };
  }
  return {
    id: 'cuenta',
    titulo: 'Canal activo',
    estado: 'mal',
    detalle: `El canal está ${cuenta.state}.`,
    queHacer: 'Vuelve a conectarlo: mientras esté así, los webhooks que lleguen se rechazan.',
  };
}

/**
 * ¿La cuenta sabe con qué emisor manda? (#526)
 *
 * Este paso faltaba y era el más caro de los que faltaban. El adaptador lee
 * `config.senderId` y sin él lanza en CADA envío, mientras los entrantes
 * siguen llegando —se resuelven por el id de la cuenta del webhook—. O sea: el
 * diagnóstico salía todo verde, el negocio veía llegar los mensajes de sus
 * clientes, y no podía contestar ninguno.
 *
 * Pasa en las cuentas conectadas antes de ADR-0014: la migración que introdujo
 * `sender_id` no rellenó el `config`. La 0005 de whatsapp lo rellena; este
 * paso es para que si vuelve a faltar, se vea de una.
 */
async function pasoDelEmisor(
  cuenta: ChannelAccountRef,
  enElProveedor?: () => Promise<{ existe: boolean; canales: string[] } | null>,
): Promise<PasoDelDiagnostico> {
  // El webchat y el simulador entregan DENTRO de la app: no hay emisor que
  // configurar y marcar esto en rojo sería mandar a arreglar algo que no
  // existe.
  if (cuenta.kind === 'webchat' || cuenta.kind === 'simulador') {
    return {
      id: 'emisor',
      titulo: 'Emisor del canal',
      estado: 'bien',
      detalle: 'Este canal entrega dentro de la app: no necesita emisor.',
    };
  }
  const senderId = cuenta.config.senderId;
  const hay = typeof senderId === 'string' && senderId.trim() !== '';
  if (!hay) {
    return {
      id: 'emisor',
      titulo: 'Emisor del canal',
      estado: 'mal',
      detalle: 'La cuenta no tiene emisor: los mensajes llegan, pero no sale ninguno.',
      queHacer:
        'Vuelve a conectar el número para que quede guardado su emisor. Mientras falte, ' +
        'puedes recibir y leer, pero no responder.',
    };
  }

  // Que haya un string guardado no es que el emisor sirva (#591). Se le
  // pregunta al proveedor, que es donde vive.
  const enProveedor = enElProveedor ? await enElProveedor().catch(() => null) : null;
  if (!enProveedor) {
    return {
      id: 'emisor',
      titulo: 'Emisor del canal',
      // «No sabemos» no es «está bien»: dar por bueno lo que no se pudo
      // comprobar es exactamente cómo este paso estuvo verde mientras no
      // salía ni un mensaje.
      estado: 'desconocido',
      detalle: 'La cuenta tiene emisor guardado, pero no pudimos preguntarle al proveedor si sigue sirviendo.',
      queHacer: 'Revisa la credencial del canal; sin ella no se puede comprobar el emisor.',
    };
  }
  if (!enProveedor.existe) {
    return {
      id: 'emisor',
      titulo: 'Emisor del canal',
      estado: 'mal',
      detalle: 'El emisor guardado ya no existe en el proveedor.',
      queHacer: 'Vuelve a conectar el número: el emisor se borró o cambió de proyecto.',
    };
  }
  if (!enProveedor.canales.includes(cuenta.kind)) {
    const nombre = cuenta.kind === 'whatsapp' ? 'WhatsApp' : cuenta.kind;
    return {
      id: 'emisor',
      titulo: 'Emisor del canal',
      estado: 'mal',
      // Este es el caso que estaba en verde y no dejaba enviar: el emisor
      // existe, está guardado, y perdió el canal.
      detalle:
        enProveedor.canales.length === 0
          ? `El emisor existe pero no tiene ningún canal activo, así que no sale ningún mensaje.`
          : `El emisor existe pero ya no tiene ${nombre} activo (hoy tiene: ${enProveedor.canales.join(', ')}).`,
      queHacer:
        `Revisa en el proveedor que la cuenta de ${nombre} siga activa y conectada a este emisor. ` +
        'Suele pasar cuando la cuenta se suspende o vence su autorización.',
    };
  }
  return {
    id: 'emisor',
    titulo: 'Emisor del canal',
    estado: 'bien',
    detalle: `La cuenta sabe con qué emisor mandar, y el proveedor confirma que tiene ${cuenta.kind} activo.`,
  };
}

function pasoDeLaCredencial(
  cuenta: ChannelAccountRef,
  hayCredencial: (ref: string | null) => boolean,
): PasoDelDiagnostico {
  const ref = cuenta.credentialRef;
  if (!ref) {
    return {
      id: 'credencial',
      titulo: 'Credencial del proveedor',
      estado: 'mal',
      detalle: 'La cuenta no dice de qué variable sacar la credencial.',
      queHacer: 'Vuelve a conectar el canal para que quede guardada la referencia.',
    };
  }
  const hay = hayCredencial(ref);
  return {
    id: 'credencial',
    titulo: 'Credencial del proveedor',
    estado: hay ? 'bien' : 'mal',
    // El NOMBRE de la variable, nunca el valor. Es lo que hay que ir a
    // arreglar y no compromete nada.
    detalle: hay ? `Presente en el ambiente (${ref}).` : `Falta ${ref} en el ambiente.`,
    ...(hay ? {} : { queHacer: `Agrega ${ref} a las variables del despliegue y vuelve a desplegar.` }),
  };
}

/**
 * El paso que resuelve el caso que costó horas dos veces.
 *
 * «Nunca llegó un webhook» y «llegan pero la firma no calza» se veían
 * exactamente igual desde adentro —la bandeja vacía— y se arreglan en
 * lugares distintos: uno es la URL configurada en el proveedor y el otro es
 * el secreto.
 */
function pasoDelWebhook(rastro: RastroDeWebhook, ahora: Date): PasoDelDiagnostico {
  if (!rastro.ultimo) {
    return {
      id: 'webhook',
      titulo: 'Webhooks recibidos',
      estado: 'mal',
      detalle: 'Nunca llegó un webhook a esta cuenta.',
      queHacer:
        'La URL del webhook en el proveedor no apunta acá, o está configurada a nivel de proyecto ' +
        'en vez de a nivel del emisor. Tiene que apuntar a /webhooks/channels/<id de esta cuenta>.',
    };
  }
  const cuando = haceCuanto(rastro.ultimo, ahora);
  if (rastro.resultado === 'aceptado') {
    return {
      id: 'webhook',
      titulo: 'Webhooks recibidos',
      estado: 'bien',
      detalle: `El último llegó ${cuando} y se aceptó.`,
    };
  }
  if (rastro.resultado === 'firma_invalida' || rastro.resultado === 'sin_secreto') {
    const nunca = !rastro.ultimoBueno;
    return {
      id: 'webhook',
      titulo: 'Webhooks recibidos',
      estado: 'mal',
      detalle:
        rastro.resultado === 'sin_secreto'
          ? `Llegó uno ${cuando}, pero la cuenta no tiene con qué verificar la firma.`
          : `Llegó uno ${cuando} y la firma no calzó.` +
            (nunca
              ? ' Nunca se aceptó uno en esta cuenta.'
              : ` El último bueno fue ${haceCuanto(rastro.ultimoBueno!, ahora)}.`),
      queHacer:
        'El secreto guardado no es el del emisor que está enviando. En el panel del proveedor, ' +
        'regenera el secreto DEL EMISOR (no el del proyecto) y guárdalo en la variable del despliegue.',
    };
  }
  return {
    id: 'webhook',
    titulo: 'Webhooks recibidos',
    estado: 'mal',
    detalle: `El último llegó ${cuando} y se rechazó (${rastro.resultado}).`,
    queHacer: 'Revisa el estado del canal más arriba.',
  };
}
