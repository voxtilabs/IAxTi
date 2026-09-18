import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import { listChannelAccounts } from '@iaxti/module-channels';
import {
  aplicarEstadoDelProveedor,
  listTemplates,
  listarEnZavu,
  sincronizarConZavu,
} from '@iaxti/module-whatsapp';

/**
 * Reconciliación de plantillas con el proveedor (#44).
 *
 * Meta avisa los cambios de estado por webhook. Un webhook se puede perder —
 * el proveedor lo dice él mismo —, y cuando se pierde la plantilla queda en
 * "en revisión" para siempre: el negocio no puede mandar nada fuera de la
 * ventana y nadie sabe por qué. Este barrido pregunta en vez de esperar.
 *
 * Solo mira tenants que tengan algo esperando: si nadie tiene plantillas en
 * revisión, no se llama al proveedor.
 */

async function credencial(
  c: PoolClient,
  tenantId: string,
): Promise<{ apiKey: string; senderId: string } | null> {
  const cuentas = await listChannelAccounts(c, tenantId);
  const cuenta = cuentas.find((a) => a.kind === 'whatsapp' && a.state === 'active');
  if (!cuenta?.credentialRef) return null;
  const apiKey = process.env[cuenta.credentialRef];
  const senderId = cuenta.config.senderId as string | undefined;
  if (!apiKey || !senderId) return null;
  return { apiKey, senderId };
}

export async function sincronizarPlantillas(
  pool: Pool,
): Promise<{ tenants: number; revisadas: number; cambiadas: number }> {
  // Los tenants con plantillas esperando respuesta del proveedor.
  const esperando = await pool.query(
    `SELECT DISTINCT tenant_id FROM whatsapp_templates WHERE status = 'pending'`,
  );
  let revisadas = 0;
  let cambiadas = 0;

  for (const fila of esperando.rows) {
    const tenantId = fila.tenant_id as string;
    try {
      const cambios = await withTenant(pool, tenantId, async (c) => {
        const cred = await credencial(c, tenantId);
        // Sin número conectado no hay a quién preguntarle. No es un error:
        // el tenant desconectó WhatsApp y sus plantillas quedaron ahí.
        if (!cred) return 0;
        const cfg = { apiKey: cred.apiKey };

        // Primero que Zavu se ponga al día con Meta, después leemos.
        await sincronizarConZavu(cfg, cred.senderId);
        const enProveedor = await listarEnZavu(cfg, cred.senderId);
        const porNombre = new Map(
          enProveedor.map((t) => [`${t.name}::${t.language}`, t] as const),
        );

        let n = 0;
        const nuestras = await listTemplates(c, tenantId);
        for (const nuestra of nuestras) {
          if (nuestra.status !== 'pending') continue;
          revisadas += 1;
          const suya = porNombre.get(`${nuestra.name}::${nuestra.language}`);
          // Un estado que no entendemos vuelve null y no se toca nada: es
          // mejor seguir esperando que inventar una aprobación.
          if (!suya?.status || suya.status === 'pending') continue;
          const r = await aplicarEstadoDelProveedor(c, {
            tenantId,
            name: nuestra.name,
            language: nuestra.language,
            status: suya.status,
            reason: suya.rejectionReason,
            providerId: suya.id,
          });
          if (r && r.status === suya.status) n += 1;
        }
        return n;
      });
      cambiadas += cambios;
    } catch (err) {
      // Un tenant con la credencial vencida no puede dejar sin barrer a los
      // demás. Se anota y se sigue.
      console.error(`plantillas.sync: ${tenantId} falló`, (err as Error).message);
    }
  }

  return { tenants: esperando.rowCount ?? 0, revisadas, cambiadas };
}
