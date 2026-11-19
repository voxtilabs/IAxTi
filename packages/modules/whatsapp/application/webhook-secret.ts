import { createGoogleSecretStore, type GoogleSecretStore, custodiaDesdeEntorno } from '@iaxti/google';
import { esNombreDeVariable } from '@iaxti/core';
import { isChannelSecretRef } from '@iaxti/module-channels';

/**
 * El secreto del webhook de una cuenta, resuelto por SU referencia (#1175).
 *
 * La cuenta guarda el NOMBRE —una variable de entorno o una llave de la
 * custodia cifrada del VPS (`wh:…`, ADR-0028)—, nunca el valor. Este archivo
 * es la única traducción de esa referencia a secreto, y existía dentro del
 * flujo de invitaciones de Zavu: cuando ese flujo salió (#1339), esta mitad
 * se quedó, porque el webhook la usa en CADA entrega.
 */
export async function resolveChannelWebhookSecret(
  account: { tenantId: string; id: string; webhookSecretRef: string | null },
  store?: GoogleSecretStore,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ref = account.webhookSecretRef;
  if (!ref) return undefined;
  if (esNombreDeVariable(ref)) return process.env[ref];
  if (!isChannelSecretRef(ref, account.tenantId, account.id)) return undefined;
  return (store ?? secretStoreDelCanal()).access(ref.slice(3), { signal });
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
