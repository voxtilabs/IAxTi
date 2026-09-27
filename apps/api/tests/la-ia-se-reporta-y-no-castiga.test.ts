import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { checkReadiness } from '../src/readiness';
import { PROVIDERS } from '@iaxti/module-agents';

/**
 * `/ready` decía «ok» con las tres credenciales de IA ausentes (#641).
 *
 * La pregunta «¿llegó la llave al contenedor?» se volvió una conversación
 * repetida, y nadie la podía contestar mirando: la sonda solo miraba postgres y
 * redis. El diagnóstico completo vive en `/agents/diagnostico` y pide sesión
 * —está bien que la pida, ahí se nombran las variables—, así que para saber si
 * un despliegue quedó con IA había que entrar al producto.
 *
 * Lo que esta suite fija son las DOS mitades, y la segunda es la que importa:
 * que se reporte, y que reportarlo **no apague nada**.
 */

const poolFalso = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as Pool;

afterEach(() => vi.unstubAllEnvs());

/** Deja el ambiente sin ninguna credencial de IA. */
function sinIa() {
  vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('GLM_API_KEY', '');
}

describe('la IA se reporta en /ready (#641)', () => {
  it('sin ninguna credencial lo dice, y dice dónde está el detalle', async () => {
    sinIa();
    const r = await checkReadiness(poolFalso, 'api');
    const ia = r.dependencias.find((d) => d.nombre === 'ia')!;
    expect(ia.ok).toBe(false);
    expect(ia.detalle).toContain('Ningún proveedor');
    expect(ia.detalle).toContain('/agents/diagnostico');
  });

  it('NO saca la instancia de rotación: se reporta, no se castiga', async () => {
    sinIa();
    const r = await checkReadiness(poolFalso, 'api');
    // Ésta es la propiedad que importa. Si esto se pusiera en `degraded`, el
    // `/ready` respondería 503, el balanceador sacaría la API y el negocio se
    // quedaría sin bandeja, sin CRM y sin webhooks —todo lo que SÍ funciona—
    // por una variable de entorno que falta.
    expect(r.status).toBe('ok');
    expect(r.dependencias.find((d) => d.nombre === 'ia')!.bloquea).toBe(false);
  });

  it('con una sola credencial ya cuenta, y no dice cuál', async () => {
    sinIa();
    vi.stubEnv('GLM_API_KEY', 'no-es-una-llave-de-verdad');
    const r = await checkReadiness(poolFalso, 'api');
    const ia = r.dependencias.find((d) => d.nombre === 'ia')!;
    expect(ia.ok).toBe(true);
    expect(ia.detalle).toBe(`1 de ${PROVIDERS.length} proveedores con credencial.`);
    // Nada de nombres acá: `/ready` es público. Cuál falta y qué variable es se
    // responde con sesión, en el diagnóstico.
    for (const p of PROVIDERS) expect(ia.detalle).not.toContain(p);
  });

  it('no publica ni un pedazo de ninguna llave', async () => {
    sinIa();
    vi.stubEnv('GLM_API_KEY', 'secreto-que-no-debe-salir');
    const r = await checkReadiness(poolFalso, 'api');
    expect(JSON.stringify(r)).not.toContain('secreto-que-no-debe-salir');
  });

  it('postgres SÍ bloquea: la excepción es la IA y nada más', async () => {
    sinIa();
    const r = await checkReadiness(null, 'api');
    expect(r.status).toBe('degraded');
  });
});
