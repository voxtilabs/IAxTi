import type { PoolClient } from 'pg';
import { exigirNombreDeVariable, publishEvent } from '@iaxti/core';
import { assertChannelTransition, PROVEEDOR_POR_OMISION, proveedoresRegistrados } from '../domain/port';
import type { ChannelAccountRef, ChannelKind, ChannelState } from '../domain/port';

function rowToAccount(row: Record<string, unknown>): ChannelAccountRef {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    kind: row.kind as ChannelKind,
    name: row.name as string,
    state: row.state as ChannelState,
    credentialRef: (row.credential_ref as string) ?? null,
    // `?? PROVEEDOR_POR_OMISION` y no `as string` a secas: una fila leída por
    // un SELECT que no pidió la columna vendría `undefined`, y eso tiene que
    // resolver a lo de siempre y no a `undefined:whatsapp`.
    provider: (row.provider as string) ?? PROVEEDOR_POR_OMISION,
    config: (row.config as Record<string, unknown>) ?? {},
  };
}

export async function createChannelAccount(
  client: PoolClient,
  input: {
    tenantId: string;
    kind: ChannelKind;
    name: string;
    credentialRef?: string;
    webhookSecretRef?: string;
    config?: Record<string, unknown>;
  },
): Promise<ChannelAccountRef> {
  // Por referencia, nunca el valor (SPEC §17). Acá no se validaba nada: el
  // runbook de producción decía que los canales rechazaban una credencial
  // pegada y eso solo era verdad en `payments` (#801). Quien le creyó y pegó
  // la llave de Zavu quedó con un secreto vivo en texto plano, en el campo
  // que después cinco mensajes de error interpolan.
  const credencial = input.credentialRef
    ? exigirNombreDeVariable(input.credentialRef, 'la referencia de la credencial')
    : null;
  const secretoDelWebhook = input.webhookSecretRef
    ? exigirNombreDeVariable(input.webhookSecretRef, 'la referencia del secreto del webhook')
    : null;
  const r = await client.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, credential_ref, webhook_secret_ref, config)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      input.tenantId,
      input.kind,
      input.name,
      credencial,
      secretoDelWebhook,
      JSON.stringify(input.config ?? {}),
    ],
  );
  return rowToAccount(r.rows[0]);
}

export async function getChannelAccount(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  lock = false,
): Promise<ChannelAccountRef & { webhookSecretRef: string | null }> {
  const r = await client.query(
    `SELECT * FROM channel_accounts WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, accountId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos esa cuenta de canal.');
  return {
    ...rowToAccount(r.rows[0]),
    webhookSecretRef: (r.rows[0].webhook_secret_ref as string) ?? null,
  };
}

/**
 * La cuenta por id. El webhook llega sin tenant, así que primero se averigua
 * con `tenantDeCuenta` y esto se llama DENTRO de `withTenant` (#286): antes
 * se leía con el pool pelado, y con el rol de producción eso devuelve cero
 * filas — cada mensaje entrante habría respondido "Nada por aquí".
 */
export async function findAccountById(
  client: PoolClient,
  accountId: string,
): Promise<(ChannelAccountRef & { webhookSecretRef: string | null }) | null> {
  const r = await client.query('SELECT * FROM channel_accounts WHERE id = $1', [accountId]);
  if (r.rowCount === 0) return null;
  return {
    ...rowToAccount(r.rows[0]),
    webhookSecretRef: (r.rows[0].webhook_secret_ref as string) ?? null,
  };
}

const EVENTO_POR_ESTADO: Partial<Record<ChannelState, string>> = {
  active: 'channel.connected',
  degraded: 'channel.degraded',
  disconnected: 'channel.disconnected',
};

export async function setChannelState(
  client: PoolClient,
  input: { tenantId: string; accountId: string; state: ChannelState; reason?: string; requestId?: string },
): Promise<ChannelAccountRef> {
  const actual = await getChannelAccount(client, input.tenantId, input.accountId);
  if (actual.state === input.state) return actual;
  assertChannelTransition(actual.state, input.state);
  const r = await client.query(
    `UPDATE channel_accounts SET state = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.accountId, input.state],
  );
  const evento = EVENTO_POR_ESTADO[input.state];
  if (evento) {
    await publishEvent(client, {
      name: evento,
      tenantId: input.tenantId,
      payload: { accountId: input.accountId, kind: actual.kind, reason: input.reason ?? null },
      actor: 'system',
      requestId: input.requestId,
    });
  }
  return rowToAccount(r.rows[0]);
}

/**
 * Cambia a qué EMISOR del proveedor apunta una cuenta ya conectada (#600).
 *
 * Existe porque faltaba la salida. Cambiar la llave de Zavu de un canal
 * conectado —de prueba a producción, por ejemplo— puede dejar el `senderId`
 * guardado apuntando a un emisor que en el proyecto de la llave nueva **no
 * existe**. Desde #591 el diagnóstico lo dice («el emisor guardado ya no existe
 * en el proveedor»), pero decirlo no era arreglarlo: `connectWhatsAppNumber` se
 * niega a correr de nuevo —«Ese número ya está conectado»— y no había ninguna
 * ruta para reapuntar ni para desconectar. El único camino era entrar a la base
 * a mano, para algo que un ADMIN tiene que poder hacer en su pantalla.
 *
 * ## Qué se conserva, y por qué importa
 *
 * El `config` se MEZCLA, no se reemplaza. Ahí vive `enviosReales` (#593), que es
 * la marca de que este canal manda mensajes de verdad fuera de producción.
 * Pisarla al reapuntar dejaría un canal mandando a clientes reales sin la marca
 * que lo declara, y esa marca es justamente lo que hace que el riesgo sea
 * visible. Lo mismo con cualquier cosa que un canal guarde ahí y esto no
 * conozca.
 *
 * Las conversaciones cuelgan de la CUENTA, no del emisor, así que reapuntar no
 * mueve historial: es el mismo canal hablando por otra boca.
 */
export class EmisorCompartidoError extends Error {}

export async function reapuntarEmisorDeLaCuenta(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    senderId: string;
    phoneNumberId?: string | null;
    wabaId?: string | null;
  },
): Promise<ChannelAccountRef> {
  // Dos cambios simultáneos deben comprobar el sender vigente, no el que
  // leyeron antes de esperar al primer cambio.
  await client.query('SELECT id FROM channel_accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [input.tenantId, input.accountId]);
  const actual = await getChannelAccount(client, input.tenantId, input.accountId);
  if (actual.config.senderId && actual.config.senderId !== input.senderId) {
    // El receptor de un sender compartido no se puede mover por el cambio de
    // número de WhatsApp: dejaría sin entrada a Instagram/Messenger. El mismo
    // candado que usa la reserva serializa esta decisión con una nueva alta.
    const reserva = await client.query<{ webhook_account_id: string | null }>(
      'SELECT webhook_account_id FROM channel_senders WHERE tenant_id=$1 AND sender_id=$2 FOR UPDATE',
      [input.tenantId, actual.config.senderId],
    );
    if (reserva.rows[0] && (reserva.rows[0].webhook_account_id === actual.id || reserva.rows[0].webhook_account_id === null)) {
      const otras = await client.query(
        "SELECT id FROM channel_accounts WHERE tenant_id=$1 AND config->>'senderId'=$2 AND id<>$3 LIMIT 1",
        [input.tenantId, actual.config.senderId, actual.id],
      );
      if (otras.rowCount) throw new EmisorCompartidoError('Este emisor comparte su webhook con otros canales. Pide a quien configura el servicio que revise la conexión antes de cambiarlo.');
    }
  }
  const config = {
    ...actual.config,
    senderId: input.senderId,
    ...(input.phoneNumberId === undefined ? {} : { phoneNumberId: input.phoneNumberId }),
    ...(input.wabaId === undefined ? {} : { wabaId: input.wabaId }),
  };
  const r = await client.query(
    `UPDATE channel_accounts SET config = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.accountId, JSON.stringify(config)],
  );
  return rowToAccount(r.rows[0]);
}

/**
 * Los canales del negocio. Los archivados vienen, SALVO que se pidan sin (#1202).
 *
 * El defecto incluye los desconectados, al revés que `listWhatsAppNumbers`, y
 * eso es a propósito: esta función tiene nueve llamadores y varios necesitan
 * verlos —el que reapunta un canal archivado, que es una operación soportada;
 * el que resuelve el webhook entrante; los barridos—. Invertir el defecto
 * movería ocho comportamientos de una vez sin revisar ninguno.
 *
 * Que el defecto quede distinto del de los números es una inconsistencia
 * reconocida: alinearlos pide una revisión llamador por llamador, con su propio
 * issue, no un cambio a ciegas acá.
 */
export async function listChannelAccounts(
  client: PoolClient,
  tenantId: string,
  opciones: { incluirDesconectados?: boolean } = {},
): Promise<ChannelAccountRef[]> {
  const incluir = opciones.incluirDesconectados ?? true;
  const r = await client.query(
    `SELECT * FROM channel_accounts
      WHERE tenant_id = $1 ${incluir ? '' : "AND state <> 'disconnected'"}
      ORDER BY created_at`,
    [tenantId],
  );
  return r.rows.map(rowToAccount);
}

/**
 * El tenant de una cuenta de canal, para el webhook que llega sin él (#286).
 *
 * `findAccountById` lee la fila completa y necesita contexto de tenant. Esto
 * es el paso anterior: con el id opaco de la URL, averigua a quién
 * pertenece. Por una función SECURITY DEFINER acotada —devuelve SOLO el
 * tenant— porque `channel_accounts` tiene RLS y el tenant es justamente lo
 * que falta para poder fijarlo.
 *
 * Con ese id, el llamador entra por `withTenant` y lee la cuenta bajo RLS.
 */
export async function tenantDeCuenta(
  client: Pick<PoolClient, 'query'>,
  accountId: string,
): Promise<string | null> {
  const r = await client.query('SELECT tenant_de_cuenta_de_canal($1) AS tenant', [accountId]);
  return (r.rows[0]?.tenant as string | null) ?? null;
}

/**
 * Avisa del cupo del canal, UNA vez al día (#1248).
 *
 * El primer defecto del 3 de noviembre fue este: el cupo se gastó a lo largo
 * de seis horas y el producto no dijo nada. El dueño se enteró cuando lo
 * importante —el mensaje de cierre del stand— no salió.
 *
 * El cerrojo es un `UPDATE` condicional y no una comprobación: con el cupo
 * agotado hay muchos jobs en la cola y cada uno que se difiere querría avisar.
 * Cincuenta avisos iguales no son cincuenta veces más útiles que uno — son una
 * campana que el dueño silencia, y entonces el aviso que importa tampoco
 * llega. Leer-y-después-escribir dejaría pasar dos; esto no, y el evento va en
 * la misma transacción que la marca.
 *
 * El día es el del CUPO, o sea UTC: el proveedor lo reinicia a medianoche UTC
 * —medido el 3 de noviembre, cuando se renovó a las 21:00 de Chile—, así que
 * el aviso se renueva con él. Se calcula en SQL para que no haya una fecha de
 * JavaScript de la que dudar.
 *
 * Devuelve `true` si avisó, para que quien llama lo pueda registrar.
 */
export async function avisarDelCupoUnaVezAlDia(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    cupo: { enviados: number; tope: number; quedan: number; reserva: number; topeAsumido: boolean };
    requestId?: string;
  },
): Promise<boolean> {
  const r = await client.query(
    `UPDATE channel_accounts
        SET config = jsonb_set(config, '{avisoDeCupo}',
                               to_jsonb((now() AT TIME ZONE 'UTC')::date::text)),
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2
        AND config->>'avisoDeCupo' IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date::text
      RETURNING id`,
    [input.tenantId, input.accountId],
  );
  if (r.rowCount !== 1) return false;
  await publishEvent(client, {
    name: 'channel.quota_threshold',
    tenantId: input.tenantId,
    payload: {
      channelAccountId: input.accountId,
      enviados: input.cupo.enviados,
      tope: input.cupo.tope,
      quedan: input.cupo.quedan,
      reservadosParaPersonas: input.cupo.reserva,
      topeAsumido: input.cupo.topeAsumido,
    },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return true;
}

/**
 * Los proveedores que alguna cuenta declara y nadie registró (ADR-0032).
 *
 * Se llama al arrancar, DESPUÉS de registrar los adaptadores. Si devuelve algo,
 * el proceso no debe levantar: una cuenta con un proveedor sin adaptador no
 * tiene por dónde mandar, y la alternativa —caer al adaptador por omisión—
 * mandaría los mensajes de un cliente por un proveedor que no es el suyo.
 *
 * Una base sin la migración 0006 todavía no tiene la función; eso no es un
 * error del arranque sino un despliegue a medio camino, y se reporta vacío.
 */
export async function proveedoresSinAdaptador(
  client: Pick<PoolClient, 'query'>,
): Promise<string[]> {
  let declarados: string[];
  try {
    const r = await client.query<{ p: string }>('SELECT proveedores_de_cuentas() AS p');
    declarados = r.rows.map((f) => f.p);
  } catch (err) {
    if ((err as { code?: string }).code === '42883') return [];
    throw err;
  }
  const registrados = new Set(proveedoresRegistrados());
  return declarados.filter((p) => !registrados.has(p));
}
