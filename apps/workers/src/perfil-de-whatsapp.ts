import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { contactoPorId, updateContact } from '@iaxti/module-crm';
import { nombreDePerfil, type IdentidadDePerfil } from '@iaxti/module-whatsapp';

/**
 * El nombre de perfil de WhatsApp, en SU PROPIO job (#1170).
 *
 * ## Por qué no vive en el job de entrada
 *
 * Porque la cola `inbound` corre de a UNO —BullMQ nace con `concurrency: 1` y
 * ese worker no la fija— y por ella pasan además `delivery-status`,
 * `quality-update`, `google-calendar.push` y `payment-webhook`. Con la consulta
 * esperada ahí dentro, cada mensaje de un contacto sin nombre retenía la única
 * ranura hasta 4 s: con Zavu lento y 20 mensajes en cola, el vigésimo aparecía
 * en la bandeja 77 s después de que la persona lo mandó, y un aviso de pago de
 * Flow encolado detrás esperaba lo mismo. Al estrenar esto el escenario no era
 * raro: HOY todos los contactos están sin nombre.
 *
 * Y había un segundo daño, más silencioso: esa espera era lo PRIMERO que pasaba
 * después del COMMIT del mensaje. BullMQ es at-least-once, así que un
 * despliegue —`apagarOrdenado` reparte 8 s entre todos los workers y Docker
 * manda SIGKILL a los 10— que cayera en esa ventana reentregaba el job, el
 * `INSERT INTO messages` chocaba con `messages_provider_id_idx` (23505), la
 * transacción se iba en ROLLBACK y los 5 intentos morían igual. El mensaje
 * quedaba en la bandeja, pero NADA de lo que viene después de `processInbound`
 * corría para él: ni las reglas de entrada ni el `agentsQueue.add('suggest')`.
 * O sea: el cliente escribe, su mensaje se ve, y el bot no contesta.
 *
 * Es el mismo patrón que el copiloto, que ya estaba resuelto así en el mismo
 * archivo: «corre DESPUÉS, en su cola: la bandeja no espera». Lo que se puede
 * morir ahora es el job del nombre, que es reintentable sin consecuencias.
 *
 * ## Por qué hay marca de intento
 *
 * Porque la condición para consultar es «el contacto no tiene nombre», y hay
 * contactos que no van a tener nombre NUNCA: Zavu no conoce el número, o el
 * perfil no tiene nombre puesto (se puede no tener). Sin marca, cada mensaje de
 * esa persona repetía la llamada para siempre — y si Zavu rate-limitea,
 * escribía «Zavu respondió 429» una vez por mensaje. El costo pasa a ser por
 * contacto y no por mensaje.
 */
export interface PerfilJob {
  moduleId?: 'whatsapp';
  tenantId: string;
  contactId: string;
  /** Ya CLASIFICADA por quien encola: teléfono o BSUID, nunca texto crudo. */
  identidad: IdentidadDePerfil;
  /** El NOMBRE de la variable con la llave del canal, no su valor. */
  credencialRef: string;
  requestId?: string;
}

/** Qué pasó. Se devuelve para que el worker lo pueda registrar y medir. */
export type ResultadoDelPerfil =
  | 'puesto'
  | 'ya-tenia-nombre'
  | 'ya-se-habia-preguntado'
  | 'sin-nombre'
  | 'sin-contacto';

/**
 * «¿Ya le preguntamos a Zavu por este contacto?»
 *
 * Es un puerto para que la prueba pueda usar un doble en memoria: el job tiene
 * que poder medirse sin Redis.
 */
export interface MarcaDeIntento {
  yaSePregunto(tenantId: string, contactId: string): Promise<boolean>;
  anotar(tenantId: string, contactId: string, segundos: number): Promise<void>;
}

/**
 * Una semana cuando la consulta SÍ se pudo hacer y no había nombre.
 *
 * No es «para siempre» a propósito: alguien que hoy no tiene nombre de perfil
 * se lo puede poner mañana, y un contacto que quedó marcado de por vida no se
 * entera nunca. Una semana deja el costo en ~una llamada por contacto por
 * semana, que es lo que se buscaba, sin cerrar la puerta.
 */
export const TTL_SIN_NOMBRE_SEG = 7 * 24 * 60 * 60;

/**
 * Quince minutos cuando el que falló fue el PROVEEDOR.
 *
 * Marcar una caída de Zavu con el plazo largo dejaría a todos los contactos de
 * todos los negocios sin nombre por una semana por un incidente de diez
 * minutos. Un fallo del proveedor no es un dato sobre el contacto.
 */
export const TTL_FALLO_SEG = 15 * 60;

/** La marca en Redis, con la clave PREFIJADA POR TENANT (`.claude/rules/db.md`). */
export function marcaEnRedis(redis: Redis): MarcaDeIntento {
  const clave = (tenantId: string, contactId: string) => `${tenantId}:perfil:${contactId}`;
  return {
    async yaSePregunto(tenantId, contactId) {
      // Redis caído no puede impedir que se ponga el nombre: ante la duda se
      // pregunta. Lo que se pierde es el ahorro, no la función.
      try {
        return (await redis.exists(clave(tenantId, contactId))) === 1;
      } catch {
        return false;
      }
    },
    async anotar(tenantId, contactId, segundos) {
      try {
        await redis.set(clave(tenantId, contactId), '1', 'EX', segundos);
      } catch {
        /* Igual que arriba: sin marca se vuelve a preguntar, y nada más. */
      }
    },
  };
}

/**
 * El `jobId` con el que se encola, para que una ráfaga sea UN job.
 *
 * Lleva el contacto y una ventana de tiempo, y la ventana no es decoración:
 * BullMQ ignora un `add` cuyo `jobId` ya existe, y con
 * `removeOnComplete: 1000` un job COMPLETADO sigue existiendo hasta que lo
 * desplacen mil más nuevos. Con el id fijo por contacto, un negocio tranquilo
 * no volvía a preguntar NUNCA —ni cuando venciera la marca de 15 minutos de un
 * fallo del proveedor—, así que la caída de Zavu de esta tarde se habría
 * quedado para siempre.
 *
 * La ventana es la misma que `TTL_FALLO_SEG` a propósito: quien decide si se
 * vuelve a preguntar es la marca, y el `jobId` solo junta los mensajes
 * seguidos de la misma persona.
 */
export function idDelJobDePerfil(job: PerfilJob, ahora: number = Date.now()): string {
  const ventana = Math.floor(ahora / (TTL_FALLO_SEG * 1000));
  return `perfil-${job.tenantId}-${job.contactId}-${ventana}`;
}

/** Una marca que no recuerda nada: para el worker sin Redis y para las pruebas. */
export const sinMarca: MarcaDeIntento = {
  yaSePregunto: async () => false,
  anotar: async () => {},
};

export interface DependenciasDelPerfil {
  marca?: MarcaDeIntento;
  /** Inyectable para medir esto POR EL PUERTO (#870). */
  fetch?: typeof globalThis.fetch;
}

export async function resolverNombreDePerfil(
  pool: Pool,
  data: PerfilJob,
  deps: DependenciasDelPerfil = {},
): Promise<ResultadoDelPerfil> {
  const marca = deps.marca ?? sinMarca;
  const marcaDeLog = `[${data.requestId ?? 'sin-request-id'}] perfil de WhatsApp`;
  // El job viaja por Redis y vuelve como JSON: la identidad se vuelve a
  // comprobar acá. Lo que evita es que un job viejo —encolado por una versión
  // anterior, con `identidad` en otra forma— mande una consulta con basura.
  const tipo = data.identidad?.tipo;
  if (tipo !== 'telefono' && tipo !== 'bsuid') {
    console.warn(`${marcaDeLog} — el job no trae una identidad que se pueda buscar`);
    return 'sin-nombre';
  }
  if (await marca.yaSePregunto(data.tenantId, data.contactId)) return 'ya-se-habia-preguntado';

  let falloElProveedor = false;
  const nombre = await nombreDePerfil(data.identidad, {
    apiKey: process.env[data.credencialRef] ?? '',
    fetch: deps.fetch,
    // El MOTIVO, nunca el dato: ni el nombre del perfil ni el teléfono entran
    // al log (`.claude/rules/seguridad.md`, PII).
    avisar: (motivo) => {
      falloElProveedor = true;
      console.warn(`${marcaDeLog} — ${motivo}`);
    },
  });

  // Se anota el intento ANTES de escribir: lo que esto evita es que el ahorro
  // dependa de que la escritura salga bien. Si el UPDATE falla, el próximo
  // mensaje vuelve a entrar por acá igual cuando venza la marca.
  await marca.anotar(
    data.tenantId,
    data.contactId,
    falloElProveedor ? TTL_FALLO_SEG : TTL_SIN_NOMBRE_SEG,
  );
  if (!nombre) return 'sin-nombre';

  return withTenant(pool, data.tenantId, async (client) => {
    // Se vuelve a leer DENTRO de la transacción que escribe, y CON CANDADO.
    // Entre la decisión de consultar y esta línea pasó una llamada de red
    // entera: si alguien del negocio le puso nombre a mano en el medio, ese
    // manda. El candado es lo que hace que esto sea una guarda y no una
    // coincidencia — sin él, dos escrituras en paralelo leen cada una el
    // estado anterior a la otra y las dos pasan.
    const contacto = await contactoPorId(client, {
      tenantId: data.tenantId,
      contactId: data.contactId,
      paraActualizar: true,
    });
    if (!contacto) return 'sin-contacto';
    if (contacto.name?.trim()) return 'ya-tenia-nombre';
    await updateContact(client, {
      tenantId: data.tenantId,
      contactId: contacto.id,
      name: nombre,
      // No lo escribió una persona: lo trajo el canal.
      actor: 'system',
      requestId: data.requestId,
    });
    // `updateContact` NO audita: solo publica `contact.updated` en el outbox.
    // Lo que esto evita es el hueco exacto que había: la ficha pasaba de
    // mostrar un número a mostrar «lucho» de forma automática, con un dato
    // traído de un tercero, y Auditoría devolvía cero filas para ese contacto.
    // La misma transacción que la mutación (`.claude/rules/seguridad.md`).
    //
    // En `metadata` NADA del nombre ni del teléfono: son el dato personal, y
    // el libro de auditoría se exporta.
    await writeAudit(client, {
      tenantId: data.tenantId,
      actor: 'system',
      actorKind: 'system',
      action: 'contact.profile_name_set',
      resource: 'contact',
      resourceId: contacto.id,
      result: 'success',
      requestId: data.requestId,
      metadata: { channel: 'whatsapp', fuente: 'zavu', identidad: data.identidad.tipo },
    });
    return 'puesto';
  });
}
