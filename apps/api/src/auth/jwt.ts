import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface VerifiedUser {
  userId: string;
  email?: string;
}

export type JwtVerifier = (token: string) => Promise<VerifiedUser>;

/**
 * Verificación del JWT de sesión de Supabase Auth (ES256 contra el JWKS
 * público del proyecto). Sin secreto compartido: la llave pública se cachea
 * y rota sola (jose maneja el remote JWKS).
 */
export function supabaseJwtVerifier(
  jwksUrl = process.env.SUPABASE_JWKS_URL,
): JwtVerifier | null {
  if (!jwksUrl) return null;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const issuer = jwksUrl.replace('/.well-known/jwks.json', '');
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer });
    if (!payload.sub) throw new Error('JWT sin sub');
    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  };
}
