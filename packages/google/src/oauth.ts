import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { createTransport, GoogleIntegrationError, inputText, invalidInput, invalidResponse, record, text,
  type GoogleRequestOptions, type GoogleTransportOptions } from './http';

const AUTHORIZATION = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const CERTIFICATES = 'https://www.googleapis.com/oauth2/v1/certs';
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.freebusy';

export interface GoogleOAuthConfig { clientId: string; clientSecret: string; redirectUri: string }
export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  /** Scopes efectivos de Google. Una respuesta sin scope no acredita permisos nuevos. */
  scope: string[];
  idToken?: string;
}
export interface GoogleIdentity { sub: string; email?: string }
export interface GoogleAuthorizationInput {
  state: string; challenge: string; nonce: string; scopes: readonly string[]; loginHint?: string;
}
export interface GoogleOAuth {
  authorizationUrl(input: GoogleAuthorizationInput): string;
  exchange(input: { code: string; verifier: string } & GoogleRequestOptions): Promise<GoogleTokens>;
  refresh(refreshToken: string, options?: GoogleRequestOptions): Promise<GoogleTokens>;
  revoke(token: string, options?: GoogleRequestOptions): Promise<void>;
  verifyIdToken(input: { idToken: string; nonce: string } & GoogleRequestOptions): Promise<GoogleIdentity>;
}

function tokens(value: unknown): GoogleTokens {
  const body = record(value);
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
    || !Number.isSafeInteger(body.expires_in) || (body.expires_in as number) <= 0) return invalidResponse();
  const scope = body.scope === undefined ? [] : text(body.scope).split(/\s+/).filter(Boolean);
  return { accessToken: text(body.access_token), expiresIn: body.expires_in as number, scope,
    ...(body.refresh_token === undefined ? {} : { refreshToken: text(body.refresh_token) }),
    ...(body.id_token === undefined ? {} : { idToken: text(body.id_token) }) };
}

export function createGoogleOAuth(config: GoogleOAuthConfig, options: GoogleTransportOptions = {}): GoogleOAuth {
  inputText(config.clientId); inputText(config.clientSecret);
  let redirect: URL;
  try { redirect = new URL(config.redirectUri); } catch { throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID'); }
  if (redirect.username || redirect.password || redirect.hash
    || (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)))) {
    throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
  }
  const client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret,
    redirectUri: config.redirectUri, transporterOptions: { timeout: options.timeoutMs ?? 10000, retry: false,
      ...(options.fetch ? { fetchImplementation: options.fetch } : {}) } });
  const request = createTransport(options);
  const form = (data: Record<string, string>, opt: GoogleRequestOptions) => request(TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...data }).toString(),
  }, opt).then(tokens);
  return {
    authorizationUrl(input) {
      inputText(input.state); inputText(input.nonce);
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.challenge) || input.scopes.length === 0
        || input.scopes.some((s) => !/^(openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._/-]+)$/.test(s))) return invalidInput();
      if (input.loginHint !== undefined) inputText(input.loginHint, 320);
      // El SDK oficial serializa OAuth; host verificado para que nunca se vuelva un proxy.
      const result = client.generateAuthUrl({ access_type: 'offline', include_granted_scopes: true,
        scope: [...new Set(input.scopes)], state: input.state, nonce: input.nonce,
        code_challenge: input.challenge, code_challenge_method: CodeChallengeMethod.S256,
        ...(input.loginHint ? { login_hint: input.loginHint } : {}) });
      if (!result.startsWith(`${AUTHORIZATION}?`)) throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
      return result;
    },
    exchange({ code, verifier, ...opt }) {
      inputText(code);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return invalidInput();
      return form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri }, opt);
    },
    refresh(refreshToken, opt = {}) {
      return form({ grant_type: 'refresh_token', refresh_token: inputText(refreshToken) }, opt);
    },
    async revoke(token, opt = {}) {
      await request(REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: inputText(token) }).toString() }, opt);
    },
    async verifyIdToken({ idToken, nonce, ...opt }) {
      inputText(idToken); inputText(nonce);
      const response = record(await request(CERTIFICATES, { method: 'GET' }, opt));
      try {
        const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString('utf8')) as { alg?: string };
        if (header.alg !== 'RS256') throw new Error();
        const certs: Record<string, string> = {};
        for (const [key, value] of Object.entries(response)) {
          if (typeof value !== 'string' || value.length > 50000) throw new Error();
          certs[key] = value;
        }
        // Certificados por el mismo transporte acotado; el SDK oficial comprueba
        // firma, issuer, expiración y audience. No hay un segundo fetch sin timeout.
        const ticket = await client.verifySignedJwtWithCertsAsync(idToken, certs, config.clientId,
          ['accounts.google.com', 'https://accounts.google.com']);
        const payload = ticket.getPayload();
        if (!payload || payload.nonce !== nonce || typeof payload.sub !== 'string'
          || !/^[\x21-\x7e]{1,255}$/.test(payload.sub)
          || (payload.azp !== undefined && payload.azp !== config.clientId)) throw new Error();
        return { sub: payload.sub, ...(payload.email_verified === true && payload.email ? { email: payload.email } : {}) };
      } catch {
        throw new GoogleIntegrationError('GOOGLE_ID_TOKEN_INVALID');
      }
    },
  };
}
