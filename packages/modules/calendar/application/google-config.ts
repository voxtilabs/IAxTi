import {
  createGoogleOAuth, createGoogleSecretStore, createLocalSecretStore, createGoogleCalendarClient,
  type GoogleOAuth, type GoogleSecretStore, type GoogleCalendarClient,
} from '@iaxti/google';

export interface CalendarGoogleDeps {
  clientId: string;
  webhookAddress: string;
  oauth: GoogleOAuth;
  secrets: GoogleSecretStore;
  calendar: GoogleCalendarClient;
  ahora?: () => Date;
}

/**
 * Dónde viven los tokens: en el VPS o en Secret Manager.
 *
 * ADR-0027 dijo «únicamente en Secret Manager»; la enmienda de v1 admite la
 * custodia local y la declara. Acá se elige UNA, nunca media: si están las
 * dos, gana la local y se dice por qué; si falta un pedazo de la elegida, la
 * función entera devuelve `null` y Calendar queda apagado, que es el
 * comportamiento que ya tenía cuando faltaba cualquier variable.
 *
 * Lo que NO se hace es caer de una a la otra en silencio: un despliegue que
 * cree estar guardando en Secret Manager y esté escribiendo en un disco
 * efímero es exactamente la clase de sorpresa que no se descubre hasta que
 * se pierden los tokens.
 */
function custodia(env: NodeJS.ProcessEnv): GoogleSecretStore | null {
  const { GOOGLE_SECRET_DIR: directorio, GOOGLE_SECRET_KEY: clave,
    GOOGLE_SECRET_PROJECT_ID: projectId, GOOGLE_SECRET_LOCATION: location } = env;
  if (directorio || clave) {
    if (!directorio || !clave) return null;
    return createLocalSecretStore({ directorio, clave });
  }
  if (!projectId || !location) return null;
  return createGoogleSecretStore({ projectId, location });
}

/** Solo configuración de servidor. Ninguna llave ni token llega al navegador. */
export function calendarGoogleDesdeEntorno(env: NodeJS.ProcessEnv = process.env): CalendarGoogleDeps | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_CALENDAR_REDIRECT_URI: redirectUri, GOOGLE_CALENDAR_WEBHOOK_URL: webhookAddress } = env;
  if (![clientId, clientSecret, redirectUri, webhookAddress].every(Boolean)) return null;
  const secrets = custodia(env);
  if (!secrets) return null;
  const address = new URL(webhookAddress!);
  if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) {
    throw new Error('La dirección del webhook de Google debe ser HTTPS y no contener credenciales ni parámetros.');
  }
  return { clientId: clientId!, webhookAddress: address.href,
    oauth: createGoogleOAuth({ clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! }),
    secrets,
    calendar: createGoogleCalendarClient() };
}
