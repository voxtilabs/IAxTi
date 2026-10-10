// Configuración en TIEMPO DE EJECUCIÓN (nunca NEXT_PUBLIC_*): la imagen se
// construye una vez en CI sin secretos y cada ambiente inyecta sus valores
// por entorno; los server components los leen y los pasan como props.
import type { PublicConfig } from '@iaxti/ui/react';
export type { PublicConfig };

export function publicConfig(): PublicConfig {
  return {
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    // `?? ` no atrapa la cadena vacía (#575): con la variable declarada sin
    // valor la app pedía contra rutas relativas y nada cargaba. Acá no se
    // importa el ayudante de `core` porque su barril arrastra `node:fs`.
    apiUrl: process.env.API_URL_PUBLIC?.trim() || 'http://localhost:3000',
    env: process.env.IAXTI_ENV?.trim() || 'local',
  };
}

/** URL de la API alcanzable desde el SERVIDOR (red interna del compose). */
export function internalApiUrl(): string {
  // La cadena de `??` lo hacía peor que un solo `??` (#575): con
  // `API_URL_INTERNAL=""` ganaba la cadena vacía y ni `API_URL_PUBLIC` ni el
  // defecto se miraban. El renderizado del servidor pedía contra `''`.
  return (
    process.env.API_URL_INTERNAL?.trim() ||
    process.env.API_URL_PUBLIC?.trim() ||
    'http://localhost:3000'
  );
}
