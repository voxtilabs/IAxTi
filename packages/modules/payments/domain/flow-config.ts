/** Destinos oficiales: https://developers.flow.cl/docs/intro. */
const SANDBOX = 'https://sandbox.flow.cl/api';
const LIVE = 'https://www.flow.cl/api';

/**
 * Un registro test nunca manda credenciales al endpoint live, aunque el
 * entorno esté mal configurado. Las credenciales solo se resuelven al usar
 * la integración: dejarlas vacías no impide arrancar el resto del sistema.
 */
export function flowConfig(credentials: string, mode: 'test' | 'live' = 'test'): {
  base: string; apiKey: string; secretKey: string;
} {
  if (mode !== 'test' && mode !== 'live') throw new Error('El modo de Flow debe ser test o live.');
  if (mode === 'live' && process.env.IAXTI_ENV !== 'production') {
    throw new Error('Flow live cobra dinero real y solo puede usarse en producción.');
  }
  const base = (process.env.FLOW_API_BASE ?? SANDBOX).trim().replace(/\/$/, '');
  if (base !== (mode === 'test' ? SANDBOX : LIVE)) {
    throw new Error(`FLOW_API_BASE no corresponde al destino oficial del modo ${mode}. Revisa la configuración de Flow.`);
  }
  const partes = credentials.split(':');
  const ejemplo = /^(?:api[_-]?key|secret[_-]?key|default|changeme|example|ejemplo|replace[_-]?me|reemplazar)$|[<>]|^(?:tu|your)[_-]/i;
  if (partes.length !== 2 || partes.some((p) => !p || /\s/.test(p) || ejemplo.test(p))) {
    throw new Error('Faltan credenciales válidas de Flow: configura apiKey:secretKey del ambiente elegido. Los valores de ejemplo no habilitan pagos.');
  }
  return { base, apiKey: partes[0], secretKey: partes[1] };
}
