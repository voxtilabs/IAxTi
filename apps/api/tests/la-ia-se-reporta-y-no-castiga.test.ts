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
 * Y si el canal de este despliegue puede mandar (#669 — nació de preguntar por
 * la llave, cuando la llave era una sola).
 *
 * Una `zv_test_` solo alcanzaba a los números del equipo en el proveedor, así
 * que el producto parecía roto —«no llegó»— cuando el ambiente solo estaba en
 * sandbox. Antes no había forma de verlo: se cambiaba la variable, se
 * desplegaba, y después se adivinaba. La única señal era mandar un mensaje de
 * verdad y ver si fallaba.
 */
describe('con qué llave quedó el canal (#669)', () => {
  const canalDe = async (pool: Pool | null) =>
    (await checkReadiness(pool, 'api')).dependencias.find((d) => d.nombre === 'canal')!;

  // La pregunta original de #669 —¿con qué clase de llave quedó el canal?— no
  // se puede seguir contestando mirando una variable: con Zernio las llaves
  // son POR CUENTA (#1338) y no hay una llave global del ambiente. Nombrar
  // `ZERNIO_API_KEY` como si existiera hizo que /ready informara «sin
  // credencial» para siempre en un ambiente con el canal andando (#1339).
  // La verdad que /ready sí puede decir: si el despliegue tiene alguna cuenta
  // viva. La de cada cuenta —su llave, su clase, si manda de verdad— sigue
  // en su diagnóstico, con `probar-envio` y la marca `enviosReales` primero.
  it('con una cuenta viva lo dice, y manda mirar el diagnóstico de cada canal', async () => {
    const vivos = { query: async () => ({ rows: [{ p: 'zernio' }] }) } as unknown as Pool;
    const c = await canalDe(vivos);
    expect(c.ok).toBe(true);
    expect(c.detalle).toContain('Hay canales de Zernio vivos');
    expect(c.detalle).toContain('su diagnóstico');
  });

  it('sin cuentas vivas lo dice: ese canal no puede enviar ni recibir', async () => {
    // `poolFalso` contesta, pero sin zernio: la honestidad es decir que no
    // hay por dónde, no inventar una credencial que no existe.
    const c = await canalDe(poolFalso);
    expect(c.ok).toBe(false);
    expect(c.detalle).toContain('Sin cuentas de canal');
  });

  it('sin base no inventa una conclusión', async () => {
    const c = await canalDe(null);
    expect(c.ok).toBe(false);
    expect(c.detalle).toContain('Sin base');
  });

  it('una base que no deja mirar se reporta, sin duplicar el fallo de postgres', async () => {
    const rota = {
      query: async () => {
        throw new Error('connection refused');
      },
    } as unknown as Pool;
    const c = await canalDe(rota);
    expect(c.ok).toBe(false);
    expect(c.detalle).toContain('No se pudo mirar');
  });

  it('no publica llave ni nombre de variable: nada de eso pasa por acá', async () => {
    // La garantía de #669 sigue en pie: quien mire /ready no se lleva ni un
    // pedazo de credencial. Con llaves por cuenta ni siquiera hay UNA que
    // mirar — pero la garantía se prueba igual, porque el día que vuelva a
    // haber algo sensible por acá cerca, es la que tiene que agarrarlo.
    const r = await checkReadiness(poolFalso, 'api');
    const texto = JSON.stringify(r);
    expect(texto).not.toContain('ZERNIO_API_KEY');
    expect(texto).not.toContain('zrk_');
  });

  it('y NO saca la instancia de rotación: el canal es cosa de las cuentas, no del servicio', async () => {
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
