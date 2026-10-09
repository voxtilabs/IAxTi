import type { PoolClient } from 'pg';
import {
  createChannelAccount,
  getChannelAccount,
  reapuntarEmisorDeLaCuenta,
  setChannelState,
} from '@iaxti/module-channels';
import type { ChannelAccountRef } from '@iaxti/module-channels';

// WhatsAppNumber (#42, ADR-0014): el número es del cliente y lo conecta él
// mismo por *partner invitation*; cuántos puede conectar lo dice su plan
// (plan_limits). El identificador operativo es el `senderId` de Zavu; los ids
// de Meta se guardan cuando aparecen, para el día del proveedor propio (#82).

export interface WhatsAppNumber {
  id: string;
  tenantId: string;
  channelAccountId: string;
  /** El sender de Zavu: por acá entra y sale todo hoy. */
  senderId: string | null;
  /** Ids de Meta: solo si el proveedor los expone. */
  phoneNumberId: string | null;
  wabaId: string | null;
  displayPhone: string | null;
  quality: 'green' | 'yellow' | 'red' | null;
  messagingLimit: string | null;
  connectedAt: Date | null;
  /** Pausa de envíos del negocio por calidad (#45); la levanta el ADMIN. */
  businessPausedAt: Date | null;
  pausedReason: string | null;
  /**
   * Cuándo se desconectó, o null si sigue en uso (#600).
   *
   * Desconectado NO es pausado: la pausa es por calidad y se levanta; esto es
   * «este número ya no es de este negocio». Libera el cupo del plan y la fila
   * se queda, porque las conversaciones que pasaron por él cuelgan de su cuenta
   * de canal y borrarla dejaría el historial sin de dónde salió.
   */
  disconnectedAt: Date | null;
}

function rowToNumber(row: Record<string, unknown>): WhatsAppNumber {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    channelAccountId: row.channel_account_id as string,
    senderId: (row.sender_id as string) ?? null,
    phoneNumberId: (row.phone_number_id as string) ?? null,
    wabaId: (row.waba_id as string) ?? null,
    displayPhone: (row.display_phone as string) ?? null,
    quality: (row.quality as WhatsAppNumber['quality']) ?? null,
    messagingLimit: (row.messaging_limit as string) ?? null,
    connectedAt: (row.connected_at as Date) ?? null,
    businessPausedAt: (row.business_paused_at as Date) ?? null,
    pausedReason: (row.paused_reason as string) ?? null,
    disconnectedAt: (row.disconnected_at as Date) ?? null,
  };
}

async function numerosPermitidos(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query(
    `SELECT COALESCE(pl.whatsapp_numbers, 1) AS max
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.id = $1`,
    [tenantId],
  );
  return r.rows[0]?.max ?? 1;
}

/**
 * El cierre de la *partner invitation*: con el `senderId` que llega en
 * `invitation.status_changed` (estado `completed`, nunca `failed` — que no es
 * terminal) se crea la cuenta de canal (credencial POR REFERENCIA) y el
 * número. Valida el tope del plan ANTES de conectar.
 */
export async function connectWhatsAppNumber(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    senderId: string;
    phoneNumberId?: string;
    wabaId?: string;
    displayPhone?: string;
    credentialRef: string;
    webhookSecretRef: string;
    /**
     * Si esta conexión manda mensajes DE VERDAD (#593). Queda en la cuenta y no
     * solo en el log de quien conectó: el log se lee una vez, el canal lo lee
     * cualquiera que entre a preguntarse por qué un mensaje salió de staging.
     */
    enviosReales?: boolean;
  },
): Promise<{ number: WhatsAppNumber; account: ChannelAccountRef }> {
  // Los desconectados NO cuentan para el cupo (#600): si contaran, un número
  // que el negocio ya dio de baja le seguiría ocupando un lugar del plan y la
  // única salida sería borrar la fila a mano — justo lo que archivar evita.
  const existentes = await client.query(
    `SELECT count(*)::int AS n FROM whatsapp_numbers
      WHERE tenant_id = $1 AND disconnected_at IS NULL`,
    [input.tenantId],
  );
  const max = await numerosPermitidos(client, input.tenantId);
  if (existentes.rows[0].n >= max) {
    throw new Error(
      `Tu plan permite ${max} número${max === 1 ? '' : 's'} de WhatsApp. Sube de plan para conectar otro.`,
    );
  }

  const account = await createChannelAccount(client, {
    tenantId: input.tenantId,
    kind: 'whatsapp',
    name: input.name,
    credentialRef: input.credentialRef,
    webhookSecretRef: input.webhookSecretRef,
    config: {
      senderId: input.senderId,
      phoneNumberId: input.phoneNumberId ?? null,
      wabaId: input.wabaId ?? null,
      ...(input.enviosReales ? { enviosReales: true } : {}),
    },
  });
  let row;
  try {
    const r = await client.query(
      `INSERT INTO whatsapp_numbers
         (tenant_id, channel_account_id, sender_id, phone_number_id, waba_id, display_phone, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
      [
        input.tenantId,
        account.id,
        input.senderId,
        input.phoneNumberId ?? null,
        input.wabaId ?? null,
        input.displayPhone ?? null,
      ],
    );
    row = r.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new Error('Ese número ya está conectado en IAxTi.');
    }
    throw err;
  }
  // Con webhook verificado el canal queda activo; #45 lo degrada por calidad.
  const activa = await setChannelState(client, {
    tenantId: input.tenantId,
    accountId: account.id,
    state: 'active',
  });
  return { number: rowToNumber(row), account: activa };
}

/**
 * Apunta el número de esta cuenta a OTRO emisor del proveedor (#600).
 *
 * El caso que lo pide es el que estamos viviendo: staging pasa de llave de
 * prueba a llave de producción, y si esa llave es de otro proyecto en Zavu el
 * `senderId` guardado no existe allá. Desde #591 el diagnóstico lo dice; lo que
 * no había era salida. `connectWhatsAppNumber` se niega —«Ese número ya está
 * conectado en IAxTi.»— y sin esto el único camino era entrar a la base.
 *
 * ## Lo que NO hace, y es deliberado
 *
 * No valida contra el proveedor. Quien llama ya eligió de una lista que salió
 * del proveedor y pasó por `elegirSender`, que es el mismo chequeo que se hace
 * al conectar: un emisor cuyo `channels` no incluya este canal se rechaza
 * **antes** de llegar acá. Repetir la llamada HTTP adentro sería preguntar dos
 * veces lo mismo y dejar a esta función sin poder probarse sin red.
 *
 * No toca las conversaciones: cuelgan de la cuenta de canal, no del emisor. Es
 * el mismo canal hablando por otra boca, y el historial se queda donde está.
 *
 * Y no reactiva el canal. Si estaba desconectado, sigue desconectado: reapuntar
 * es decir POR DÓNDE habla, no decidir que vuelva a hablar — eso lo decide quien
 * reconecta, y así una cuenta que alguien dio de baja no revive de lado.
 */
export async function reapuntarEmisor(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    senderId: string;
    phoneNumberId?: string | null;
    wabaId?: string | null;
    displayPhone?: string | null;
  },
): Promise<{ number: WhatsAppNumber; account: ChannelAccountRef }> {
  const cuenta = await getChannelAccount(client, input.tenantId, input.accountId);
  if (cuenta.kind !== 'whatsapp') {
    throw new Error('Esa cuenta no es de WhatsApp.');
  }
  const r = await client.query(
    `UPDATE whatsapp_numbers
        SET sender_id = $3,
            phone_number_id = COALESCE($4, phone_number_id),
            waba_id = COALESCE($5, waba_id),
            display_phone = COALESCE($6, display_phone),
            updated_at = now()
      WHERE tenant_id = $1 AND channel_account_id = $2
      RETURNING *`,
    [
      input.tenantId,
      input.accountId,
      input.senderId,
      input.phoneNumberId ?? null,
      input.wabaId ?? null,
      input.displayPhone ?? null,
    ],
  );
  if (r.rowCount === 0) throw new Error('Esa cuenta no tiene un número de WhatsApp conectado.');
  const account = await reapuntarEmisorDeLaCuenta(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    senderId: input.senderId,
    ...(input.phoneNumberId === undefined ? {} : { phoneNumberId: input.phoneNumberId }),
    ...(input.wabaId === undefined ? {} : { wabaId: input.wabaId }),
  });
  return { number: rowToNumber(r.rows[0]), account };
}

/**
 * Da de baja el número de una cuenta, sin perder lo que pasó por él (#600).
 *
 * Archiva, no borra: las conversaciones cuelgan de la cuenta de canal, y borrar
 * la fila del número dejaría el historial sin de dónde salió. Es la regla del
 * producto (SPEC §39) y acá además es lo que permite reconectar después.
 *
 * Libera el cupo del plan —`connectWhatsAppNumber` no cuenta los desconectados—
 * que es la mitad del problema: un número que ya no sirve seguía ocupando lugar.
 *
 * El canal queda `disconnected`, y eso es lo que apaga los envíos: el estado del
 * canal es lo que mira el despacho, no esta columna.
 */
export async function desconectarNumero(
  client: PoolClient,
  input: { tenantId: string; accountId: string; motivo?: string; requestId?: string },
): Promise<{ number: WhatsAppNumber; account: ChannelAccountRef }> {
  const r = await client.query(
    `UPDATE whatsapp_numbers
        SET disconnected_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND channel_account_id = $2 AND disconnected_at IS NULL
      RETURNING *`,
    [input.tenantId, input.accountId],
  );
  if (r.rowCount === 0) {
    throw new Error('Esa cuenta no tiene un número de WhatsApp conectado.');
  }
  const account = await setChannelState(client, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    state: 'disconnected',
    reason: input.motivo ?? 'el ADMIN desconectó el canal',
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return { number: rowToNumber(r.rows[0]), account };
}

export async function listWhatsAppNumbers(
  client: PoolClient,
  tenantId: string,
): Promise<WhatsAppNumber[]> {
  const r = await client.query(
    'SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return r.rows.map(rowToNumber);
}

/** El envelope trae `senderId`: con eso se ubica tenant y cuenta. */
export async function findNumberBySenderId(
  client: PoolClient,
  senderId: string,
): Promise<WhatsAppNumber | null> {
  const r = await client.query('SELECT * FROM whatsapp_numbers WHERE sender_id = $1', [senderId]);
  return r.rowCount === 0 ? null : rowToNumber(r.rows[0]);
}
