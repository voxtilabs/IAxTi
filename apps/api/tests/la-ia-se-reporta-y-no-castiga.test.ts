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

/**
 * Y con qué llave quedó el canal (#669).
 *
 * Una `zv_test_` solo alcanza a los números del equipo en el proveedor, así que
 * el producto parece roto —«no llegó»— cuando el ambiente solo está en sandbox.
 * Antes no había forma de verlo: se cambiaba la variable, se desplegaba, y
 * después se adivinaba. La única señal era mandar un mensaje de verdad y ver si
 * fallaba.
 */
describe('con qué llave quedó el canal (#669)', () => {
  const canal = async () =>
    (await checkReadiness(poolFalso, 'api')).dependencias.find((d) => d.nombre === 'canal')!;

  it('una llave de PRUEBA se dice, y se dice qué significa', async () => {
    vi.stubEnv('ZAVU_API_KEY', 'zv_test_abc123');
    const c = await canal();
    expect(c.detalle).toContain('PRUEBA');
    expect(c.detalle).toContain('números del equipo');
  });

  it('una de producción también', async () => {
    vi.stubEnv('ZAVU_API_KEY', 'zv_live_abc123');
    expect((await canal()).detalle).toBe('Credencial de producción.');
  });

  it('sin credencial lo dice: ese canal no puede enviar ni recibir', async () => {
    vi.stubEnv('ZAVU_API_KEY', '');
    const c = await canal();
    expect(c.ok).toBe(false);
    expect(c.detalle).toContain('Sin credencial');
  });

  it('una forma desconocida NO se declara de producción', async () => {
    // Decir «producción» de algo que no se reconoce es la clase de mentira que
    // esto viene a evitar.
    vi.stubEnv('ZAVU_API_KEY', 'algo-raro');
    expect((await canal()).detalle).toContain('no reconocemos');
  });

  it('no publica la llave, ni un pedazo, ni el nombre de la variable', async () => {
    vi.stubEnv('ZAVU_API_KEY', 'zv_live_secretoquenodebesalir');
    const r = await checkReadiness(poolFalso, 'api');
    const texto = JSON.stringify(r);
    expect(texto).not.toContain('secretoquenodebesalir');
    expect(texto).not.toContain('ZAVU_API_KEY');
  });

  it('y NO saca la instancia de rotación: una llave de prueba es legítima en pruebas', async () => {
    vi.stubEnv('ZAVU_API_KEY', '');
    const r = await checkReadiness(poolFalso, 'api');
    expect(r.status).toBe('ok');
    expect(r.dependencias.find((d) => d.nombre === 'canal')!.bloquea).toBe(false);
  });
});

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
