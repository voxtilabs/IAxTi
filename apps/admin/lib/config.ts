// Configuración en TIEMPO DE EJECUCIÓN (nunca NEXT_PUBLIC_*): la imagen se
// construye una vez en CI sin secretos y cada ambiente inyecta sus valores
// por entorno; los server components los leen y los pasan como props.
import type { PublicConfig } from '@iaxti/ui/react';
export type { PublicConfig };

export function publicConfig(): PublicConfig {
  return {
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    apiUrl: process.env.API_URL_PUBLIC ?? 'http://localhost:3000',
    env: process.env.IAXTI_ENV ?? 'local',
  };
}

/** URL de la API alcanzable desde el SERVIDOR (red interna del compose). */
export function internalApiUrl(): string {
  return process.env.API_URL_INTERNAL ?? process.env.API_URL_PUBLIC ?? 'http://localhost:3000';
}
