import { notFound } from 'next/navigation';
import { publicConfig } from '../../lib/config';
import { EntrarLocal } from './entrar-local-client';

export const dynamic = 'force-dynamic';

/**
 * La puerta del AMBIENTE LOCAL (#1047), con doble cerradura.
 *
 * Firma la sesión el servicio auth-local del compose — el equivalente humano
 * del JWKS que el e2e levanta para Playwright. Esta página no existe si:
 *
 * 1. `IAXTI_LOGIN_DEV` no es exactamente '1' (solo el compose local la pone), o
 * 2. `IAXTI_ENV` dice staging o production — aunque alguien copiara el flag,
 *    acá se muere igual. La misma variable que ya gobierna el aislamiento
 *    (rls.ts), Sentry y los links de pago: no hay una segunda fuente de
 *    verdad sobre en qué ambiente estamos.
 *
 * `notFound()` y no un cartel: una puerta que explica por qué está cerrada
 * le enseña al que golpea que existe.
 */
export default function EntrarLocalPage() {
  if (process.env.IAXTI_LOGIN_DEV !== '1') notFound();
  const ambiente = process.env.IAXTI_ENV;
  if (ambiente === 'production' || ambiente === 'staging') notFound();
  return <EntrarLocal config={publicConfig()} />;
}
