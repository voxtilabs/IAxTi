import type { Pool, PoolClient } from 'pg';
import { idsDeTenants, withTenant } from '@iaxti/db';
import { getProvider, listChannelAccounts } from '@iaxti/module-channels';
import type { ChannelAccountRef, PuertoDePlantillas } from '@iaxti/module-channels';
import {
  aplicarEstadoDelProveedor,
  ESTADOS_PLANTILLA,
  listTemplates,
  sincronizarConZavu,
} from '@iaxti/module-whatsapp';
import type { EstadoPlantilla } from '@iaxti/module-whatsapp';

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

/**
 * La cuenta lista para preguntarle al proveedor (#159).
 *
 * Devuelve la CUENTA y su puerto de plantillas, no una credencial suelta:
 * el adaptador sabe sacar de la cuenta lo que necesita, y este worker deja
 * de saber de quién es la API del otro lado. La credencial sigue por
 * referencia — acá solo se comprueba que la variable exista.
 */
async function cuentaConPlantillas(
  c: PoolClient,
  tenantId: string,
): Promise<{ cuenta: ChannelAccountRef; senderId: string; plantillas: PuertoDePlantillas } | null> {
  const cuentas = await listChannelAccounts(c, tenantId);
  const cuenta = cuentas.find((a) => a.kind === 'whatsapp' && a.state === 'active');
  if (!cuenta?.credentialRef || !process.env[cuenta.credentialRef]) return null;
  const senderId = cuenta.config.senderId as string | undefined;
  if (!senderId) return null;
  const plantillas = getProvider(cuenta.kind)?.plantillas;
  if (!plantillas) return null;
  return { cuenta, senderId, plantillas };
}

export async function sincronizarPlantillas(
  pool: Pool,
): Promise<{ tenants: number; revisadas: number; cambiadas: number }> {
  // Los tenants se sacan de `tenants`, no de `whatsapp_templates` (#286):
  // esa tabla tiene RLS y una consulta suelta devuelve cero filas con el rol
  // de producción. Era mío, de este mismo día.
  let revisadas = 0;
  let cambiadas = 0;
  let conPendientes = 0;

  for (const tenantId of await idsDeTenants(pool)) {
    try {
      const cambios = await withTenant(pool, tenantId, async (c) => {
        const hay = await c.query(
          `SELECT 1 FROM whatsapp_templates WHERE tenant_id = $1 AND status = 'pending' LIMIT 1`,
          [tenantId],
        );
        if (hay.rowCount === 0) return 0; // sin nada esperando, no se molesta al proveedor
        conPendientes += 1;
        const conexion = await cuentaConPlantillas(c, tenantId);
        // Sin número conectado no hay a quién preguntarle. No es un error:
        // el tenant desconectó WhatsApp y sus plantillas quedaron ahí.
        if (!conexion) return 0;

        // Que el proveedor se ponga al día con Meta antes de leer. Esto
        // SIGUE siendo específico de Zavu a propósito: es una peculiaridad
        // suya —su copia se queda atrás de Meta— y no una operación que
        // todo proveedor tenga. Ponerlo en el puerto sería inventarle a los
        // demás una obligación que no les corresponde; el día que Zavu se
        // vaya, esta línea se va con él y el resto queda igual.
        const apiKey = process.env[conexion.cuenta.credentialRef!]!;
        await sincronizarConZavu({ apiKey }, conexion.senderId);

        const enProveedor = await conexion.plantillas.listar(conexion.cuenta);
        const porNombre = new Map(
          enProveedor.map((t) => [`${t.name}::${t.language}`, t] as const),
        );

        let n = 0;
        const nuestras = await listTemplates(c, tenantId);
        for (const nuestra of nuestras) {
          if (nuestra.status !== 'pending') continue;
          revisadas += 1;
          const suya = porNombre.get(`${nuestra.name}::${nuestra.language}`);
          // Un estado que no entendemos NO se aplica: mejor seguir
          // esperando que inventar una aprobación. El puerto devuelve el
          // estado como texto —cada proveedor tiene los suyos— y acá se
          // comprueba contra los nuestros antes de escribir nada.
          if (!suya?.status || suya.status === 'pending') continue;
          if (!(ESTADOS_PLANTILLA as readonly string[]).includes(suya.status)) continue;
          const r = await aplicarEstadoDelProveedor(c, {
            tenantId,
            name: nuestra.name,
            language: nuestra.language,
            status: suya.status as EstadoPlantilla,
            reason: suya.motivoDeRechazo,
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

  return { tenants: conPendientes, revisadas, cambiadas };
}
