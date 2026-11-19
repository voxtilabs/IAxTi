import type { PoolClient } from 'pg';
import { exigirNombreDeVariable, publishEvent } from '@iaxti/core';
import { assertChannelTransition, PROVEEDOR_POR_OMISION, proveedorDe, proveedoresRegistrados } from '../domain/port';
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

/**
 * El proveedor con el que nace una cuenta que no declaró uno (#1339).
 *
 * El `DEFAULT` de la columna es UNO para todos los canales (migración 0010) y
 * no puede saber el `kind`: una cuenta de webchat nacida con ese defecto
 * declararía `zernio`, que no atiende webchat, y quedaría huérfana de
 * adaptador al primer arranque. Los canales que son SU propio transporte
 * —webchat, simulador— nacen declarándose a sí mismos; los demás, al por
 * omisión del registro.
 */
function proveedorPorOmisionDelCanal(kind: ChannelKind): string {
  return kind === 'webchat' || kind === 'simulador' ? kind : PROVEEDOR_POR_OMISION;
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
    /**
     * Quién transporta la cuenta (ADR-0032). Sin esto la fila nace con el por
     * omisión de SU canal (ver `proveedorPorOmisionDelCanal`): `zernio` para
     * whatsapp, y el canal mismo para webchat/simulador, que son su propio
     * transporte. Declararlo a mano exige que esté registrado en ESTE
     * proceso — un nombre que nadie atiende no se guarda.
     */
    provider?: string;
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
  if (input.provider !== undefined && !proveedorDe({ kind: input.kind, provider: input.provider })) {
    throw new Error(`El proveedor "${input.provider}" no atiende el canal ${input.kind} en este proceso.`);
  }
  // La columna se nombra SIEMPRE: el por omisión de canal (#1339) es decisión
  // de este código y no del DEFAULT de la columna, que no puede saber el kind.
  const r = await client.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, credential_ref, webhook_secret_ref, config, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.tenantId,
      input.kind,
      input.name,
      credencial,
      secretoDelWebhook,
      JSON.stringify(input.config ?? {}),
      input.provider ?? proveedorPorOmisionDelCanal(input.kind),
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
 * Cambiar a qué EMISOR apunta una cuenta ya conectada (#600) se retiró con
 * Zavu (#1339): una cuenta de Zernio queda atada a su número al conectarla,
 * y el emisor —con su webhook compartido entre canales de un mismo sender—
 * era una cosa de Zavu. Si algún día vuelve a hacer falta, la historia
 * completa vive en el git de #1339.
 */

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

/**
 * Los proveedores que este despliegue tiene con cuenta viva (ADR-0032).
 *
 * Es la misma fuente que la guarda de arranque — `proveedores_de_cuentas()`,
 * SECURITY DEFINER— y existe por el mismo motivo: con las llaves POR CUENTA de
 * Zernio (#1338) no hay una llave global del ambiente que mirar para saber si
 * acá se puede mandar. Lo que lo dice es si hay alguna cuenta que pueda, y
 * cruzar tenants a mano no se puede: el rol de aplicación vive bajo RLS.
 *
 * Que la llave de una cuenta concreta esté de verdad en el ambiente lo
 * comprueba el envío al usarla —y falla con su motivo a la vista—, no una
 * verificación de configuración que no puede saberlo (#869).
 *
 * Una base sin la migración 0006 todavía no tiene la función: mismo trato que
 * la guarda, se reporta vacío y no se inventa un fallo.
 */
export async function proveedoresDeCuentas(
  client: Pick<PoolClient, 'query'>,
): Promise<string[]> {
  try {
    const r = await client.query<{ p: string }>('SELECT proveedores_de_cuentas() AS p');
    return r.rows.map((f) => f.p);
  } catch (err) {
    if ((err as { code?: string }).code === '42883') return [];
    throw err;
  }
}
