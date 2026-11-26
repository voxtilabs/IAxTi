import { createGoogleSecretStore, type GoogleSecretStore, custodiaDesdeEntorno } from '@iaxti/google';
import { esNombreDeVariable } from '@iaxti/core';
import { isChannelSecretRef, referenciaEnCustodia } from '@iaxti/module-channels';

/**
 * Los secretos de una cuenta de canal, resueltos por SU referencia.
 *
 * La cuenta guarda el NOMBRE —una variable de entorno o una llave de la
 * custodia cifrada del VPS (ADR-0028)—, nunca el valor. Este archivo es la
 * única traducción de esa referencia a secreto, para las dos cosas que una
 * cuenta guarda así: la llave del proveedor y el secreto del webhook.
 *
 * Tres formas, en el orden en que se prueban:
 *
 * - `ZERNIO_API_KEY_…`: una variable de entorno. Así conecta el script de
 *   soporte y así quedaron las cuentas anteriores a #1393.
 * - `cu:…`: la custodia, escrita por el alta desde la app (#1393, ADR-0038).
 *   Se resuelve solo si el id es de ESTA cuenta y de ESTE tipo de secreto.
 * - `sm:…`: la forma histórica del secreto del webhook (#1175). Nadie la
 *   escribe desde #1339, pero puede haber filas vivas.
 *
 * Cualquier otra cosa es «no hay secreto». Nunca se intenta adivinar.
 */
export async function resolveChannelWebhookSecret(
  account: { tenantId: string; id: string; webhookSecretRef: string | null },
  store?: GoogleSecretStore,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ref = account.webhookSecretRef;
  if (!ref) return undefined;
  if (esNombreDeVariable(ref)) return process.env[ref];
  const enCustodia = referenciaEnCustodia(ref, account.tenantId, account.id, 'webhook');
  if (enCustodia) return (store ?? secretStoreDelCanal()).access(enCustodia, { signal });
  if (!isChannelSecretRef(ref, account.tenantId, account.id)) return undefined;
  return (store ?? secretStoreDelCanal()).access(ref.slice(3), { signal });
}

/**
 * La llave del proveedor de la cuenta (#1393).
 *
 * Antes cada lugar que la necesitaba hacía `process.env[cuenta.credentialRef]`
 * —el envío, el diagnóstico, las plantillas, la descarga de adjuntos—, y una
 * cuenta conectada desde la app habría quedado muda en el que se olvidara.
 * Ahora hay un solo camino, y la guarda `la-llave-se-lee-en-un-solo-lugar`
 * impide la quinta copia.
 *
 * `undefined` es «no hay llave»: quien llama decide si eso es un error.
 */
export async function credencialDeLaCuenta(
  account: { tenantId: string; id: string; credentialRef: string | null },
  store?: GoogleSecretStore,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ref = account.credentialRef;
  if (!ref) return undefined;
  if (esNombreDeVariable(ref)) return process.env[ref] || undefined;
  const enCustodia = referenciaEnCustodia(ref, account.tenantId, account.id, 'llave');
  if (!enCustodia) return undefined;
  return (store ?? secretStoreDelCanal()).access(enCustodia, { signal });
}

/**
 * ¿Hay llave? Para el diagnóstico: la LEE de verdad (#869, «una verificación
 * que mira la configuración no verifica la función»), pero el valor no sale
 * de acá. Un fallo de la custodia es «no hay», con el motivo en el log.
 */
export async function hayCredencialDeLaCuenta(
  account: { tenantId: string; id: string; credentialRef: string | null },
  store?: GoogleSecretStore,
): Promise<boolean> {
  try {
    return Boolean(await credencialDeLaCuenta(account, store));
  } catch (err) {
    console.warn(`[canales] no se pudo leer la llave de la cuenta ${account.id} en la custodia: ${(err as Error).name}`);
    return false;
  }
}

/**
 * Dónde se guardan los secretos del canal (#1175, ADR-0028).
 *
 * En v1 la custodia es el disco cifrado del VPS y Secret Manager es la
 * opción; el selector vive en `@iaxti/google` para que no haya una segunda
 * versión. Sin custodia configurada esto lanza — y el webhook lo traduce en
 * su 503 de «no pudimos verificar, reintenta», que es la verdad.
 */
export function secretStoreDelCanal(): GoogleSecretStore {
  const custodia = custodiaDesdeEntorno(createGoogleSecretStore);
  if (!custodia) {
    throw new Error(
      'Falta decir dónde se guardan los secretos del canal. Pide a quien configura el servicio que defina GOOGLE_SECRET_DIR y GOOGLE_SECRET_KEY.',
    );
  }
  return custodia;
}
