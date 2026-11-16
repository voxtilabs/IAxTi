import type { Pool, PoolClient } from 'pg';

/**
 * El rastro del último webhook (#434).
 *
 * «No me llegan los mensajes» era imposible de responder: el producto no
 * guardaba si había llegado un webhook. Y las causas son cuatro y se
 * arreglan en lugares distintos —el webhook apunta a otra parte, el secreto
 * no corresponde al emisor, la cuenta está desconectada, o nadie escribió—
 * que desde adentro se veían todas iguales.
 *
 * No se guarda el cuerpo ni la firma. El cuerpo trae el mensaje de una
 * persona y la firma es material de un secreto: para diagnosticar alcanza
 * con CUÁNDO y CÓMO terminó.
 */
export type ResultadoDeWebhook =
  | 'aceptado'
  | 'firma_invalida'
  | 'sin_secreto'
  | 'cuenta_desconectada'
  | 'sin_proveedor'
  /**
   * Llegó, y se rechazó porque la conexión no está confirmada (#1180).
   *
   * Sin esto el rechazo no dejaba rastro y el diagnóstico decía «nunca llegó
   * un webhook», que manda a cambiar una URL que está bien. «No llegó ninguno»
   * y «llegaron y los rechazamos nosotros» son problemas distintos con
   * arreglos distintos — que es, textual, el motivo por el que esta tabla
   * existe (#434).
   */
  | 'conexion_sin_confirmar'
  /**
   * Llegó firmado, y era de OTRA cuenta o de otro negocio (#1321).
   *
   * Con Zernio la firma prueba que el evento es de Zernio, no que sea de esta
   * cuenta: el evento trae su cuenta, su perfil y el `externalId` del perfil,
   * y si alguno no calza se rechaza. Que quede anotado aparte es lo que deja
   * distinguir «se cruzó un evento» de «la firma está mal», que se arreglan en
   * lugares distintos.
   */
  | 'perfil_ajeno';

/**
 * Anota el resultado, sin convertir cada mensaje en una escritura.
 *
 * Un negocio activo recibe miles de webhooks al día y todos caen en la
 * MISMA fila: escribirla en cada uno la vuelve un punto caliente y deja
 * basura que el vacuum tiene que limpiar. Para diagnosticar no hace falta
 * el segundo exacto del último, así que se escribe solo cuando cambia el
 * resultado o cuando pasó más de un minuto.
 *
 * El caso que importa —el primero que falla después de una racha buena— se
 * escribe SIEMPRE, porque cambia el resultado.
 */
export async function anotarWebhook(
  client: Pick<Pool, 'query'> | PoolClient,
  input: { tenantId: string; accountId: string; resultado: ResultadoDeWebhook; cada?: number },
): Promise<void> {
  const cada = input.cada ?? 60;
  await client.query(
    `UPDATE channel_accounts
        SET last_webhook_at = now(),
            last_webhook_result = $3,
            last_webhook_ok_at = CASE WHEN $3 = 'aceptado' THEN now() ELSE last_webhook_ok_at END
      WHERE tenant_id = $1 AND id = $2
        AND (last_webhook_result IS DISTINCT FROM $3
             OR last_webhook_at IS NULL
             OR last_webhook_at < now() - make_interval(secs => $4))`,
    [input.tenantId, input.accountId, input.resultado, cada],
  );
}

export interface RastroDeWebhook {
  ultimo: Date | null;
  resultado: ResultadoDeWebhook | null;
  ultimoBueno: Date | null;
  /** Mensajes que llegaron sin teléfono y no pudieron entrar (#1331). */
  sinTelefono: { cuantos: number; ultimo: Date | null };
}

/**
 * Anota mensajes que llegaron sin teléfono (#1331).
 *
 * El webhook se acepta igual —reintentarlo no le va a poner un número—, pero el
 * mensaje no entra a la bandeja: IAxTi identifica al contacto por teléfono. Se
 * cuenta para que el diagnóstico lo diga y para saber si pasa de verdad, que es
 * lo que decide cuándo hay que aprender a recibirlos.
 */
export async function anotarEntrantesSinTelefono(
  client: Pick<Pool, 'query'> | PoolClient,
  input: { tenantId: string; accountId: string; cuantos: number },
): Promise<void> {
  if (input.cuantos <= 0) return;
  await client.query(
    `UPDATE channel_accounts
        SET inbound_sin_telefono = inbound_sin_telefono + $3,
            inbound_sin_telefono_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.accountId, input.cuantos],
  );
}

export async function rastroDeWebhook(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<RastroDeWebhook> {
  const r = await client.query(
    `SELECT last_webhook_at, last_webhook_result, last_webhook_ok_at,
            inbound_sin_telefono, inbound_sin_telefono_at
       FROM channel_accounts WHERE tenant_id = $1 AND id = $2`,
    [tenantId, accountId],
  );
  const fila = r.rows[0] ?? {};
  return {
    ultimo: (fila.last_webhook_at as Date) ?? null,
    resultado: (fila.last_webhook_result as ResultadoDeWebhook) ?? null,
    ultimoBueno: (fila.last_webhook_ok_at as Date) ?? null,
    sinTelefono: {
      cuantos: Number(fila.inbound_sin_telefono ?? 0),
      ultimo: (fila.inbound_sin_telefono_at as Date) ?? null,
    },
  };
}
