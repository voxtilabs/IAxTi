import { esProduccion, textoDeEntorno } from '@iaxti/core';

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
  // `esProduccion()` y no `process.env.IAXTI_ENV !== 'production'` (#575):
  // con la variable declarada SIN VALOR, `''` no es `'production'` y esto
  // reventaba EN producción. El mensaje manda a mirar el ambiente —correcto—
  // pero la causa era una variable vacía, no un ambiente equivocado.
  if (mode === 'live' && !esProduccion()) {
    throw new Error('Flow live cobra dinero real y solo puede usarse en producción.');
  }
  // Con `?? SANDBOX`, una `FLOW_API_BASE` en blanco dejaba `base = ''` y el
  // error de abajo acusaba a la variable de «no corresponder al destino
  // oficial» cuando lo que pasaba es que estaba vacía (#575).
  const base = textoDeEntorno('FLOW_API_BASE', SANDBOX).replace(/\/$/, '');
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
