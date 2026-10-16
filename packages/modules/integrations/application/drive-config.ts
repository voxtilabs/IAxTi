import { createGoogleOAuth, createGoogleSecretStore, createGoogleDriveClient, type GoogleDriveClient } from '@iaxti/google';
import type { GoogleConsentDeps } from '@iaxti/module-identity';
import type { ModuleRegistry } from '@iaxti/core';

export interface DriveDeps extends GoogleConsentDeps {
  drive:GoogleDriveClient;
  registry:ModuleRegistry;
  /** Configuración pública del Picker, nunca una llave del servidor. */
  picker:{apiKey:string;appId:string};
}
export function driveDesdeEntorno(registry:ModuleRegistry,env:NodeJS.ProcessEnv=process.env):DriveDeps|null {
  const {GOOGLE_CLIENT_ID:clientId,GOOGLE_CLIENT_SECRET:clientSecret,GOOGLE_DRIVE_REDIRECT_URI:redirectUri,
    GOOGLE_SECRET_PROJECT_ID:projectId,GOOGLE_SECRET_LOCATION:location,
    GOOGLE_PICKER_API_KEY:apiKey,GOOGLE_PICKER_APP_ID:appId}=env;
  if(![clientId,clientSecret,redirectUri,projectId,location,apiKey,appId].every(Boolean))return null;
  if(!/^\d+$/.test(appId!))throw new Error('El identificador público de Google Picker debe ser el número del proyecto.');
  return {clientId:clientId!,oauth:createGoogleOAuth({clientId:clientId!,clientSecret:clientSecret!,redirectUri:redirectUri!}),
    secrets:createGoogleSecretStore({projectId:projectId!,location:location!}),drive:createGoogleDriveClient(),registry,
    picker:{apiKey:apiKey!,appId:appId!}};
}
