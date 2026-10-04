import type { PoolClient } from 'pg';
import { listCursor } from './list-cursor';
import { publishEvent } from '@iaxti/core';
import { listCustomFields, validarCustom } from './campos';
import { isOptOutMessage, normalizePhone, normalizeRut } from '../domain/validation';

export type ContactOrigin =
  | 'whatsapp'
  | 'webchat'
  | 'importado'
  | 'manual'
  | 'instagram'
  | 'messenger';

/** Canales que identifican a un contacto (#74). El simulador imita WhatsApp. */
export type IdentityChannel = 'whatsapp' | 'webchat' | 'instagram' | 'messenger' | 'simulador';

export interface Contact {
  id: string;
  tenantId: string;
  /**
   * Teléfono E.164: es la identidad del canal WhatsApp, no la del contacto.
   * null para quien llegó por webchat con correo (#46) o por Instagram y
   * Messenger, que solo traen un id de chat (#74).
   */
  phone: string | null;
  name: string | null;
  email: string | null;
  rut: string | null;
  ownerId: string | null;
  origin: ContactOrigin;
  optInAt: Date | null;
  /**
   * Por qué canal dio el consentimiento, y con qué evidencia (#696).
   *
   * La regla pide las tres cosas —fecha, canal, evidencia— y se guardaban las
   * tres desde el principio. `rowToContact` mapeaba solo la fecha, así que el
   * canal y la evidencia estaban en la base y no salían por ninguna parte: ni
   * en la ficha, ni en el export del titular.
   *
   * Importa porque no son equivalentes. Quien dio opt-in por el formulario del
   * sitio no consintió recibir WhatsApp, y el día que alguien reclame —«yo nunca
   * autoricé que me escribieran»— la evidencia para contestarle estaba escrita y
   * sin forma de mostrarla. Una evidencia que no se puede mostrar no es evidencia.
   */
  optInChannel: string | null;
  optInEvidence: string | null;
  optedOutAt: Date | null;
  custom: Record<string, unknown>;
}

function rowToContact(row: Record<string, unknown>): Contact {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    phone: (row.phone as string) ?? null,
    name: (row.name as string) ?? null,
    email: (row.email as string) ?? null,
    rut: (row.rut as string) ?? null,
    ownerId: (row.owner_id as string) ?? null,
    origin: row.origin as ContactOrigin,
    optInAt: (row.opt_in_at as Date) ?? null,
    optInChannel: (row.opt_in_channel as string) ?? null,
    optInEvidence: (row.opt_in_evidence as string) ?? null,
    optedOutAt: (row.opted_out_at as Date) ?? null,
    custom: (row.custom as Record<string, unknown>) ?? {},
  };
}

export interface CreateContactInput {
  tenantId: string;
  phone: string;
  name?: string;
  email?: string;
  rut?: string;
  ownerId?: string;
  origin?: ContactOrigin;
  requestId?: string;
  actor?: string;
}

export async function createContact(client: PoolClient, input: CreateContactInput): Promise<Contact> {
  const phone = normalizePhone(input.phone);
  const rut = input.rut ? normalizeRut(input.rut) : null;
  const result = await client.query(
    `INSERT INTO contacts (tenant_id, phone, name, email, rut, owner_id, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [input.tenantId, phone, input.name ?? null, input.email ?? null, rut, input.ownerId ?? null, input.origin ?? 'manual'],
  );
  const contact = rowToContact(result.rows[0]);
  await publishEvent(client, {
    name: 'contact.created',
    tenantId: input.tenantId,
    payload: { contactId: contact.id, origin: contact.origin },
    actor: input.actor,
    requestId: input.requestId,
  });
  return contact;
}

/**
 * Registra la identidad de un contacto en un canal. Idempotente: la misma
 * identidad dos veces no duplica ni pisa a quién apunta.
 */
export async function linkIdentity(
  client: PoolClient,
  input: { tenantId: string; contactId: string; channel: IdentityChannel; identity: string },
): Promise<void> {
  await client.query(
    `INSERT INTO contact_identities (tenant_id, contact_id, channel, identity)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, channel, identity) DO NOTHING`,
    [input.tenantId, input.contactId, input.channel, input.identity],
  );
}

/**
 * ¿Es un teléfono la identidad que llavea el hilo, o es opaca?
 *
 * El `contactIdentifier` de un canal NO es un teléfono: es el identificador
 * con que el canal llavea la conversación. En WhatsApp casi siempre ES un
 * E.164, pero quien adoptó nombre de usuario y escondió su número llega como
 * BSUID (`US.13491208655302741918`) y un grupo llega como JID (`...@g.us`).
 * Devuelve el E.164 normalizado cuando de verdad es un teléfono y `null`
 * cuando no lo es.
 *
 * Ojo con lo que esto NO hace: no relaja la validación. El teléfono se sigue
 * normalizando con las mismas reglas de siempre; lo único que cambia es que
 * una identidad que no es un teléfono deja de ir por ese camino.
 */
/**
 * Las formas que SÍ puede tener una identidad de WhatsApp (#615).
 *
 * #604 arregló que un BSUID se validara como teléfono chileno —el mensaje se
 * perdía después del 200— pero lo arregló de más: pasó a aceptar **cualquier
 * cosa** como identidad opaca. Y eso tiene un costo que se ve con un ejemplo:
 * `ig_17841400000009` es un id de Instagram llegando por el canal `whatsapp`.
 * Aceptarlo crea un contacto con una identidad que ningún envío va a poder usar,
 * y el problema se descubre el día que alguien le quiera contestar.
 *
 * La documentación de Zavu enumera las formas: «un E.164, un BSUID de WhatsApp
 * (`US.13491208655302741918`), un id numérico de chat, o un JID de grupo
 * (`...@g.us`)». Son tres formas concretas, no «lo que venga».
 *
 * Así que se aceptan esas y se rechaza el resto — que es lo que #606 pedía con
 * su `INBOUND_IDENTIDAD_NO_RESUELTA`: un mensaje que no se puede resolver no
 * puede desaparecer en silencio, pero tampoco puede entrar como un contacto que
 * no sirve. Los dos hallazgos eran ciertos y se resolvían juntos.
 */
function formaConocidaDeWhatsApp(identity: string): boolean {
  // BSUID: el identificador de quien adoptó nombre de usuario y escondió su
  // número. El prefijo es `US.` y el resto son dígitos.
  if (/^US\.\d{6,}$/.test(identity)) return true;
  // JID de grupo.
  if (/^\d{6,}@g\.us$/.test(identity)) return true;
  return false;
}

function telefonoDeLaIdentidad(identity: string): string | null {
  try {
    return normalizePhone(identity);
  } catch {
    return null;
  }
}

/**
 * El camino de los canales (SPEC §10, #74): al llegar un mensaje de alguien
 * desconocido se crea el contacto, lo identifique un teléfono o un id de chat.
 * Idempotente por (tenant, canal, identidad).
 *
 * WhatsApp y el simulador se resuelven por teléfono CUANDO la identidad es un
 * teléfono —es la identidad de ese canal y el dedupe histórico vive ahí—; si
 * es opaca (BSUID, JID de grupo) siguen por la tabla de identidades, igual que
 * Instagram y Messenger, que no traen teléfono que valga.
 */
export async function ensureContactByIdentity(
  client: PoolClient,
  input: {
    tenantId: string;
    channel: IdentityChannel;
    identity: string;
    origin: ContactOrigin;
    name?: string;
    requestId?: string;
  },
): Promise<{ contact: Contact; created: boolean }> {
  // Por qué esto no es un `if` cualquiera: antes TODA identidad de WhatsApp se
  // desviaba por acá y `normalizePhone` lanzaba con lo que no fuera un número.
  // El webhook ya había respondido 200, así que Zavu daba el mensaje por
  // entregado y no reintentaba NUNCA: el mensaje se perdía para siempre y en la
  // bandeja no aparecía nada. El adaptador hacía bien su parte dejando
  // `phone: data.from` opaco; el que rompía la regla —«trátalo como opaco»— era
  // este desvío.
  if (input.channel === 'whatsapp' || input.channel === 'simulador') {
    const phone = telefonoDeLaIdentidad(input.identity);
    // No es teléfono Y no es una forma conocida del canal: no se inventa un
    // contacto con una identidad que ningún envío podrá usar. Se lanza, y quien
    // procesa el job lo convierte en el error del formato único (#606, #615).
    if (!phone && !formaConocidaDeWhatsApp(input.identity)) {
      throw new Error('IDENTIDAD_DESCONOCIDA');
    }
    if (phone) {
      const res = await ensureContactByPhone(client, {
        tenantId: input.tenantId,
        phone,
        origin: input.origin,
        requestId: input.requestId,
      });
      await linkIdentity(client, {
        tenantId: input.tenantId,
        contactId: res.contact.id,
        channel: 'whatsapp',
        identity: res.contact.phone ?? phone,
      });
      return res;
    }
    // Identidad opaca: cae al camino de la tabla de identidades, abajo. Se
    // guarda bajo SU canal (`whatsapp` o `simulador`) y no siempre bajo
    // `whatsapp`, porque la respuesta sale buscando la identidad del canal de
    // la conversación; guardarla bajo otro canal la dejaría sin destino, y sin
    // teléfono al que caer de respaldo.
  }

  const existing = await client.query(
    `SELECT k.* FROM contact_identities i
       JOIN contacts k ON k.id = i.contact_id
      WHERE i.tenant_id = $1 AND i.channel = $2 AND i.identity = $3`,
    [input.tenantId, input.channel, input.identity],
  );
  if ((existing.rowCount ?? 0) > 0) {
    const row = existing.rows[0];
    // Un contacto fusionado apunta a su principal (#34): el canal siempre
    // conversa con el que quedó vivo.
    if (row.merged_into) {
      const principal = await client.query(
        'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, row.merged_into],
      );
      if ((principal.rowCount ?? 0) > 0) {
        return { contact: rowToContact(principal.rows[0]), created: false };
      }
    }
    return { contact: rowToContact(row), created: false };
  }

  // Sin teléfono ni correo: el contacto nace con el nombre que dé el canal, o
  // sin nombre. Inventarle un teléfono sería mentirle a la ficha.
  const result = await client.query(
    `INSERT INTO contacts (tenant_id, phone, name, origin)
     VALUES ($1, NULL, $2, $3) RETURNING *`,
    [input.tenantId, input.name ?? null, input.origin],
  );
  const contact = rowToContact(result.rows[0]);
  await linkIdentity(client, {
    tenantId: input.tenantId,
    contactId: contact.id,
    channel: input.channel,
    identity: input.identity,
  });
  await publishEvent(client, {
    name: 'contact.created',
    tenantId: input.tenantId,
    payload: { contactId: contact.id, origin: contact.origin },
    actor: 'system',
    requestId: input.requestId,
  });
  return { contact, created: true };
}

/**
 * Identidad del contacto en un canal, para responderle por donde escribió.
 * WhatsApp cae al teléfono cuando el contacto es anterior a la tabla.
 */
export async function identityFor(
  client: PoolClient,
  input: { tenantId: string; contactId: string; channel: IdentityChannel },
): Promise<string | null> {
  const r = await client.query(
    `SELECT identity FROM contact_identities
      WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3 LIMIT 1`,
    [input.tenantId, input.contactId, input.channel],
  );
  if ((r.rowCount ?? 0) > 0) return r.rows[0].identity as string;
  const k = await client.query('SELECT phone FROM contacts WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.contactId,
  ]);
  return (k.rows[0]?.phone as string) ?? null;
}

/**
 * El camino de los canales (SPEC §10): al llegar un mensaje de un teléfono
 * desconocido se crea el contacto. Idempotente por (tenant, phone).
 */
export async function ensureContactByPhone(
  client: PoolClient,
  input: { tenantId: string; phone: string; origin: ContactOrigin; requestId?: string },
): Promise<{ contact: Contact; created: boolean }> {
  const phone = normalizePhone(input.phone);
  const existing = await client.query(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND phone = $2',
    [input.tenantId, phone],
  );
  if ((existing.rowCount ?? 0) > 0) {
    const row = existing.rows[0];
    // Un contacto fusionado apunta a su principal (#34): el canal siempre
    // conversa con el que quedó vivo.
    if (row.merged_into) {
      const principal = await client.query(
        'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, row.merged_into],
      );
      if ((principal.rowCount ?? 0) > 0) {
        return { contact: rowToContact(principal.rows[0]), created: false };
      }
    }
    return { contact: rowToContact(row), created: false };
  }
  const contact = await createContact(client, { ...input, phone, actor: 'system' });
  return { contact, created: true };
}

/** Lo mismo que respondía el UPDATE cuando no encontraba la ficha. */
const CONTACTO_NO_EXISTE = 'No encontramos ese contacto. Puede que se haya eliminado.';

/**
 * Cambio rechazado porque dejaría la ficha sin forma de reconocer a nadie.
 *
 * Lleva `code` para que la API responda con el formato único sin adivinar por
 * el texto del mensaje: el mensaje es para la persona, el código para la
 * interfaz.
 */
export class CambioDeContactoRechazado extends Error {
  constructor(
    readonly code: 'ULTIMO_IDENTIFICADOR',
    message: string,
  ) {
    super(message);
    this.name = 'CambioDeContactoRechazado';
  }
}

export async function updateContact(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    name?: string | null;
    email?: string | null;
    rut?: string | null;
    ownerId?: string;
    custom?: Record<string, unknown>;
    requestId?: string;
    actor?: string;
  },
): Promise<Contact> {
  const rut = input.rut !== undefined ? (input.rut ? normalizeRut(input.rut) : null) : undefined;

  // Los campos personalizados se validan contra lo DECLARADO (issue 248):
  // tipo, obligatoriedad y opciones de lista. Lo que el negocio ya tenía
  // guardado de antes sigue pasando — declarar un campo nuevo no puede
  // romper todas las fichas viejas de golpe.
  let custom = input.custom;
  if (custom && Object.keys(custom).length > 0) {
    const declarados = await listCustomFields(client, input.tenantId, 'contact').catch(() => []);
    custom = validarCustom(declarados, custom);
  }

  // No se borra el ÚLTIMO identificador. A un contacto lo reconocemos por su
  // teléfono, por su correo o por su identidad en algún canal; sin ninguna de
  // las tres queda un registro huérfano —con conversaciones, actividades y
  // oportunidades colgando— que nadie puede volver a amarrar a una persona, y
  // que el próximo mensaje de esa misma persona no encuentra: se abre otra
  // ficha en blanco al lado. El caso real es el visitante del webchat que solo
  // dejó su correo (#46) y después pide que se lo saquen: #480 hizo que el
  // borrado por fin funcionara, y con eso destrabó también este camino.
  // Borrar de verdad los datos del titular tiene su propia puerta, auditada
  // (`suprimirTitular`, SPEC §39); esta pantalla no es esa puerta.
  if (input.email !== undefined && !input.email) {
    // `FOR NO KEY UPDATE` porque esto es leer para decidir si se escribe: sin
    // el candado, dos ediciones en paralelo ven cada una el identificador que
    // la otra está borrando y las dos pasan.
    const ficha = await client.query(
      'SELECT phone, email FROM contacts WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE',
      [input.tenantId, input.contactId],
    );
    if (ficha.rowCount === 0) throw new Error(CONTACTO_NO_EXISTE);
    // Si ya venía sin correo no se está borrando nada: no hay por qué rechazar
    // algo que no cambia la ficha.
    if (!ficha.rows[0].phone && ficha.rows[0].email) {
      const enCanales = await client.query(
        'SELECT 1 FROM contact_identities WHERE tenant_id = $1 AND contact_id = $2 LIMIT 1',
        [input.tenantId, input.contactId],
      );
      if (enCanales.rowCount === 0) {
        throw new CambioDeContactoRechazado(
          'ULTIMO_IDENTIFICADOR',
          'No podemos sacarle el correo: es lo único con que reconocemos a este contacto. Agrégale un teléfono primero, o si te lo pidió el titular, usa la supresión de datos de su ficha.',
        );
      }
    }
  }

  // Mandar `null` BORRA; no mandar el campo lo deja como estaba. Antes
  // `name` e `email` iban por COALESCE, así que borrarlos era imposible:
  // el contacto que pidió que le sacaran el correo se quedaba con él y la
  // pantalla parecía no hacer nada (#480). El RUT ya distinguía las dos
  // cosas y ahora los tres se comportan igual.
  const result = await client.query(
    `UPDATE contacts SET
       name = CASE WHEN $3::boolean THEN $4 ELSE name END,
       email = CASE WHEN $5::boolean THEN $6 ELSE email END,
       rut = CASE WHEN $7::boolean THEN $8 ELSE rut END,
       owner_id = COALESCE($9, owner_id),
       custom = custom || COALESCE($10::jsonb, '{}'::jsonb),
       updated_at = now(),
       last_activity_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [
      input.tenantId,
      input.contactId,
      input.name !== undefined,
      input.name || null,
      input.email !== undefined,
      input.email || null,
      rut !== undefined,
      rut ?? null,
      input.ownerId ?? null,
      custom ? JSON.stringify(custom) : null,
    ],
  );
  if (result.rowCount === 0) throw new Error(CONTACTO_NO_EXISTE);
  const contact = rowToContact(result.rows[0]);
  await publishEvent(client, {
    name: 'contact.updated',
    tenantId: input.tenantId,
    payload: { contactId: contact.id },
    actor: input.actor,
    requestId: input.requestId,
  });
  return contact;
}

/** Opt-in con evidencia (fecha, canal, evidencia — SPEC §8). */
export async function registerOptIn(
  client: PoolClient,
  input: { tenantId: string; contactId: string; channel: string; evidence: string },
): Promise<void> {
  await client.query(
    `UPDATE contacts SET opt_in_at = now(), opt_in_channel = $3, opt_in_evidence = $4,
            opted_out_at = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.contactId, input.channel, input.evidence],
  );
}

/** Marca opt-out y publica contact.opted_out. */
export async function optOut(
  client: PoolClient,
  input: { tenantId: string; contactId: string; reason: string; requestId?: string },
): Promise<void> {
  await client.query(
    'UPDATE contacts SET opted_out_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2',
    [input.tenantId, input.contactId],
  );
  await publishEvent(client, {
    name: 'contact.opted_out',
    tenantId: input.tenantId,
    payload: { contactId: input.contactId, reason: input.reason },
    requestId: input.requestId,
  });
}

/**
 * Camino automático (SPEC §8): si el mensaje entrante es "BASTA"/"STOP"/etc.,
 * marca el opt-out. Los canales lo llaman con cada mensaje.
 */
export async function handleInboundForConsent(
  client: PoolClient,
  input: { tenantId: string; contactId: string; text: string; requestId?: string },
): Promise<{ optedOut: boolean }> {
  if (!isOptOutMessage(input.text)) return { optedOut: false };
  await optOut(client, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    reason: `mensaje del contacto: "${input.text.slice(0, 80)}"`,
    requestId: input.requestId,
  });
  return { optedOut: true };
}

/** ¿Puede recibir mensajes iniciados por el negocio? (SPEC §8) */
/**
 * Orígenes en los que el contacto escribió PRIMERO. `importado` y `manual`
 * no están: ahí el contacto nunca nos habló, y necesita opt-in explícito.
 */
export const ORIGENES_DE_CANAL: readonly ContactOrigin[] = [
  'whatsapp',
  'webchat',
  'instagram',
  'messenger',
];

export async function canReceiveBusinessInitiated(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const result = await client.query(
    'SELECT opt_in_at, opted_out_at, origin FROM contacts WHERE tenant_id = $1 AND id = $2',
    [tenantId, contactId],
  );
  if (result.rowCount === 0) return false;
  const { opt_in_at, opted_out_at, origin } = result.rows[0];
  if (opted_out_at) return false;
  // Escribió primero (origen de canal) o dio opt-in registrado. Los
  // orígenes que valen son TODOS los canales: quien nos escribió por
  // Instagram o Messenger (#74) inició la conversación igual que quien
  // escribió por WhatsApp. Dejarlos fuera los trataba como sin opt-in y
  // mataba en silencio toda automatización hacia ellos.
  return Boolean(opt_in_at) || ORIGENES_DE_CANAL.includes(origin as ContactOrigin);
}

/** Lista para /contactos (#34): búsqueda por nombre o teléfono, cursor. */
export async function listContacts(
  client: PoolClient,
  tenantId: string,
  filters: { q?: string; cursor?: string; limit?: number; sort?: string; order?: string } = {},
): Promise<{ items: Array<Contact & { lastActivityAt: Date }>; nextCursor: string | null }> {
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1', 'merged_into IS NULL'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(name ILIKE $${params.length} OR phone LIKE $${params.length})`);
  }
  const pagination = listCursor({
    columns: { activity: { sql: 'last_activity_at', type: 'timestamptz' }, name: { sql: 'name', type: 'text' }, phone: { sql: 'phone', type: 'text' }, origin: { sql: 'origin', type: 'text' } },
    defaultSort: 'activity', sort: filters.sort, order: filters.order, cursor: filters.cursor, limit: filters.limit,
    scope: [tenantId, filters.q?.trim() ?? ''], idColumn: 'id', params,
  });
  const { limit } = pagination;
  if (pagination.where) where.push(pagination.where);
  params.push(limit + 1);
  const r = await client.query(
    `SELECT *, ${pagination.selectValue} FROM contacts WHERE ${where.join(' AND ')}
      ORDER BY ${pagination.orderBy} LIMIT $${params.length}`,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({ ...rowToContact(row), lastActivityAt: row.last_activity_at as Date })),
    nextCursor: hasMore && last
      ? pagination.encode(last)
      : null,
  };
}

/**
 * El contacto del webchat (#46): se enlaza por teléfono (normalizado, el
 * mismo camino de siempre) o, si no lo dio, por correo. Nace origin
 * webchat — escribió primero, así que puede recibir respuestas.
 */
export async function ensureWebContact(
  client: PoolClient,
  input: {
    tenantId: string;
    name?: string;
    phone?: string;
    email?: string;
    requestId?: string;
  },
): Promise<{ contact: Contact; created: boolean }> {
  const email = input.email?.trim().toLowerCase() || undefined;
  if (input.phone?.trim()) {
    const res = await ensureContactByPhone(client, {
      tenantId: input.tenantId,
      phone: input.phone,
      origin: 'webchat',
      requestId: input.requestId,
    });
    if (input.name || email) {
      const contact = await updateContact(client, {
        tenantId: input.tenantId,
        contactId: res.contact.id,
        name: res.contact.name ?? input.name,
        email: res.contact.email ?? email,
        requestId: input.requestId,
      });
      return { contact, created: res.created };
    }
    return res;
  }
  if (!email) throw new Error('Para seguir la conversación dinos tu teléfono o tu correo.');
  const existente = await client.query(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND email = $2 AND phone IS NULL',
    [input.tenantId, email],
  );
  if ((existente.rowCount ?? 0) > 0) {
    return { contact: rowToContact(existente.rows[0]), created: false };
  }
  const r = await client.query(
    `INSERT INTO contacts (tenant_id, phone, name, email, origin)
     VALUES ($1, NULL, $2, $3, 'webchat') RETURNING *`,
    [input.tenantId, input.name ?? null, email],
  );
  const contact = rowToContact(r.rows[0]);
  await publishEvent(client, {
    name: 'contact.created',
    tenantId: input.tenantId,
    payload: { contactId: contact.id, origin: 'webchat' },
    actor: 'system',
    requestId: input.requestId,
  });
  return { contact, created: true };
}

/**
 * El correo de un contacto, y nada más.
 *
 * Existe porque `payments` lo necesita para crear la orden en Flow —que exige
 * el email del pagador— y lo estaba leyendo con un `SELECT email FROM contacts`
 * desde dentro de su propio módulo. Eso es justo lo que la regla de
 * arquitectura prohíbe: consultar la tabla de otro módulo. `depcruise` no lo
 * caza porque no hay import que cazar; es SQL, y el SQL no tiene tipos que
 * revisar.
 *
 * Angosta a propósito, y no `getContactFicha`: la ficha trae el contacto, sus
 * oportunidades y sus actividades en tres consultas, y **lanza** si el contacto
 * no existe. Para resolver un correo eso es caro y además cambia el
 * comportamiento — un cobro no se cae porque el contacto se borró. Acá un
 * contacto que no está devuelve null, que es lo que quien cobra puede manejar.
 */
export async function getContactEmail(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<string | null> {
  const r = await client.query('SELECT email FROM contacts WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    contactId,
  ]);
  const email = ((r.rows[0]?.email as string | null) ?? '').trim();
  return email === '' ? null : email;
}
