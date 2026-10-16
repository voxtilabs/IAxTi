import {
  createGoogleOAuth, createGoogleSecretStore, createGoogleCalendarClient,
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

/** Solo configuración de servidor. Ninguna llave ni token llega al navegador. */
export function calendarGoogleDesdeEntorno(env: NodeJS.ProcessEnv = process.env): CalendarGoogleDeps | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_CALENDAR_REDIRECT_URI: redirectUri, GOOGLE_CALENDAR_WEBHOOK_URL: webhookAddress,
    GOOGLE_SECRET_PROJECT_ID: projectId, GOOGLE_SECRET_LOCATION: location } = env;
  if (![clientId, clientSecret, redirectUri, webhookAddress, projectId, location].every(Boolean)) return null;
  const address = new URL(webhookAddress!);
  if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) {
    throw new Error('La dirección del webhook de Google debe ser HTTPS y no contener credenciales ni parámetros.');
  }
  return { clientId: clientId!, webhookAddress: address.href,
    oauth: createGoogleOAuth({ clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! }),
    secrets: createGoogleSecretStore({ projectId: projectId!, location: location! }),
    calendar: createGoogleCalendarClient() };
}
