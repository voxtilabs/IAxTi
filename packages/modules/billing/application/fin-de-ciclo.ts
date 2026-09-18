import type { Pool, PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';

/**
 * El final del ciclo de vida del tenant (issue 218, SPEC §6).
 *
 * El SPEC dice `suspended → deleted` a los 90 días, con exportación ofrecida
 * antes. La decisión tomada (y escrita acá para que se pueda discutir) es
 * que **el sistema avisa y una persona borra**.
 *
 * El borrado es irreversible y se lleva datos de los clientes de nuestro
 * cliente. Un error de fecha, un negocio que estaba negociando su vuelta, o
 * una factura que se pagó y no se registró — cualquiera termina en datos que
 * no se pueden recuperar. Con la cantidad de tenants del primer año, un clic
 * al mes no es una carga; automatizarlo después es fácil, des-automatizarlo
 * cuando ya borró algo, no.
 *
 * Lo que sí es automático es el AVISO, porque olvidarse de avisar es la
 * forma barata de que alguien pierda sus datos sin enterarse.
 */

/** Días suspendido antes de avisar. Quedan 15 para reaccionar. */
export const DIAS_HASTA_AVISAR = 75;

/** Días suspendido a partir de los cuales el SPEC permite borrar. */
export const DIAS_HASTA_BORRAR = 90;

export interface TenantPorBorrar {
  id: string;
  name: string;
  suspendidoDesde: Date;
  diasSuspendido: number;
  avisadoEl: Date | null;
  /** true cuando ya pasó el plazo del SPEC y el borrado está habilitado. */
  borrable: boolean;
}

/**
 * Lo que ve el SuperAdmin: quién está en la cola, hace cuánto, y si ya se le
 * avisó. Ordenado por antigüedad — el que lleva más tiempo, primero.
 */
export async function tenantsPorBorrar(
  client: Pick<PoolClient, 'query'>,
  desdeDias = DIAS_HASTA_AVISAR,
): Promise<TenantPorBorrar[]> {
  const r = await client.query(
    `SELECT id, name, state_since, deletion_warned_at,
            EXTRACT(DAY FROM now() - state_since)::int AS dias
       FROM tenants
      WHERE state = 'suspended'
        AND state_since < now() - make_interval(days => $1)
      ORDER BY state_since`,
    [desdeDias],
  );
  return r.rows.map((x) => ({
    id: x.id as string,
    name: x.name as string,
    suspendidoDesde: x.state_since as Date,
    diasSuspendido: x.dias as number,
    avisadoEl: (x.deletion_warned_at as Date | null) ?? null,
    borrable: (x.dias as number) >= DIAS_HASTA_BORRAR,
  }));
}

/**
 * Avisa a quien corresponda que la cuenta está en la cola de borrado.
 *
 * Una vez por tenant: la marca vive en `deletion_warned_at`. Repetir el
 * aviso todos los días del barrido lo convertiría en ruido, y el ruido se
 * ignora — que es exactamente lo contrario de lo que este aviso busca.
 *
 * El ADMIN de un tenant suspendido SÍ puede entrar y descargar su
 * exportación (la suspensión corta los envíos, no el acceso), así que el
 * aviso no es una cortesía vacía: apunta a algo que la persona puede hacer.
 */
export async function avisarBorradoPendiente(
  pool: Pool,
): Promise<{ avisados: number; enCola: number }> {
  const pendientes = await pool.query(
    `SELECT id FROM tenants
      WHERE state = 'suspended'
        AND state_since < now() - make_interval(days => $1)
        AND deletion_warned_at IS NULL`,
    [DIAS_HASTA_AVISAR],
  );

  let avisados = 0;
  for (const fila of pendientes.rows) {
    const tenantId = fila.id as string;
    try {
      await withTenant(pool, tenantId, async (client) => {
        // Se relee dentro de la transacción: entre la consulta de arriba y
        // esto, alguien pudo reactivar la cuenta desde el panel.
        const actual = await client.query(
          `SELECT state, name, deletion_warned_at,
                  EXTRACT(DAY FROM now() - state_since)::int AS dias
             FROM tenants WHERE id = $1 FOR UPDATE`,
          [tenantId],
        );
        const t = actual.rows[0];
        if (!t || t.state !== 'suspended' || t.deletion_warned_at) return;

        await client.query('UPDATE tenants SET deletion_warned_at = now() WHERE id = $1', [tenantId]);
        await publishEvent(client, {
          name: 'tenant.deletion_warned',
          tenantId,
          payload: {
            diasSuspendido: t.dias as number,
            diasRestantes: Math.max(0, DIAS_HASTA_BORRAR - (t.dias as number)),
          },
          actor: 'system',
        });
        await writeAudit(client, {
          tenantId,
          actor: 'system',
          actorKind: 'system',
          action: 'tenant.deletion_warned',
          resource: 'tenant',
          resourceId: tenantId,
          result: 'ok',
          metadata: { diasSuspendido: t.dias, name: t.name },
        });
        avisados += 1;
      });
    } catch (err) {
      // Un tenant que falla no puede dejar sin avisar a los demás.
      console.error(`aviso de borrado: ${tenantId} falló`, (err as Error).message);
    }
  }

  const cola = await pool.query(
    `SELECT count(*)::int AS n FROM tenants
      WHERE state = 'suspended' AND state_since < now() - make_interval(days => $1)`,
    [DIAS_HASTA_BORRAR],
  );
  return { avisados, enCola: (cola.rows[0]?.n as number) ?? 0 };
}
