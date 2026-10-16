import { beforeEach, describe, expect, it } from 'vitest';
import { probarLaIa, PROMPT_DE_PRUEBA } from '../application/probar-la-ia';
import type { ModelPortFactory } from '../application/models';
import type { Provider } from '../domain/config';
import { FalloDelProveedor } from '../application/fallo-del-proveedor';

/**
 * «Probá la IA ahora» (#869).
 *
 * Esta prueba existe por una queja del dueño que es el mejor título que tuvo
 * el issue: «no puedes ver por qué demonios no funciona la IA dentro, si es el
 * núcleo y nunca he podido conversar con ella».
 *
 * Tenía razón, y el motivo era que las tres verificaciones que había miraban la
 * CONFIGURACIÓN: `/ready` si la variable no está vacía, el diagnóstico qué
 * proveedor tiene cada tarea, y `por-que-no-sugirio` una corrida pasada.
 * Ninguna le hablaba al proveedor, así que 51 corridas fallidas en tres semanas
 * convivieron con todo en verde (#866).
 *
 * El caso que importa es el primero de abajo: credencial presente, cuenta sin
 * saldo. Es el que ocurrió, y es el que ninguna verificación anterior podía
 * distinguir de «funciona».
 */
const SOLO = (...cuales: Provider[]) => (p: Provider) => cuales.includes(p);

/**
 * Una fábrica que falla como falla el puerto de verdad.
 *
 * `FalloDelProveedor` y no un `Error` pelado, a propósito: el adaptador real
 * envuelve todo lo que sale de `generate` con esa marca, y `motivoDelProveedor`
 * se NIEGA a clasificar lo que no puede probar que vino del proveedor (#684,
 * tras una madrugada diagnosticando una cuenta sana porque un permiso denegado
 * nuestro salía como «tu proveedor se quedó sin saldo»).
 *
 * Un doble que lanza un `Error` suelto probaría un camino que en producción no
 * existe, y además devolvería siempre `desconocido`: la prueba pasaría igual y
 * no mediría nada de lo que dice medir.
 */
const queFalla = (mensaje: string): ModelPortFactory => () => ({
  generate: async () => {
    throw FalloDelProveedor.de(new Error(mensaje));
  },
});

const queContesta = (texto: string, extra: Record<string, unknown> = {}): ModelPortFactory => () => ({
  generate: async (args) => {
    // Que la prueba use NUESTRO prompt y no uno de quien prueba: una prueba
    // que no es comparable entre dos corridas no sirve para comparar nada.
    expect(args.prompt).toBe(PROMPT_DE_PRUEBA);
    return { text: texto, tokensIn: 20, tokensOut: 5, ...extra };
  },
});

import { castigar, estaCastigado, olvidarLosCastigos } from '../application/castigados';

beforeEach(() => olvidarLosCastigos());

describe('probar la IA de verdad (#869)', () => {
  /**
   * El botón es lo que alguien aprieta DESPUÉS de cargar crédito (#855).
   *
   * Si la prueba dijera «contesta» y el producto siguiera saltando ese
   * proveedor por un castigo de hace tres minutos, la herramienta de
   * diagnóstico estaría contradiciendo al producto — que es justo lo que vino
   * a arreglar. Así que un éxito perdona.
   */
  it('contestar levanta el castigo, que es para lo que se aprieta el botón', async () => {
    castigar('openai', 'sin_saldo');
    expect(estaCastigado('openai')).toBe(true);
    const r = await probarLaIa(
      { settings: null },
      { hayLlave: SOLO('openai'), modelPortFactory: queContesta('listo') },
    );
    expect(r.contesto).toBe(true);
    expect(estaCastigado('openai'), 'contestó y sigue apartado').toBe(false);
  });

  it('y fallar por algo que no se arregla reintentando lo aparta', async () => {
    const r = await probarLaIa(
      { settings: null },
      {
        hayLlave: SOLO('openai'),
        modelPortFactory: queFalla('429 RESOURCE_EXHAUSTED · credits are depleted'),
      },
    );
    expect(r.motivo).toBe('sin_saldo');
    // Una prueba a mano es una llamada real: vale como evidencia.
    expect(estaCastigado('openai')).toBe(true);
  });

  it('tiene credencial y NO tiene saldo: lo dice, en vez de contar como disponible', async () => {
    const r = await probarLaIa(
      { settings: null },
      {
        hayLlave: SOLO('google'),
        modelPortFactory: queFalla(
          '429 RESOURCE_EXHAUSTED · Your prepayment credits are depleted',
        ),
        ahora: (() => {
          let t = 1000;
          return () => (t += 120);
        })(),
      },
    );
    expect(r.contesto).toBe(false);
    expect(r.motivo).toBe('sin_saldo');
    // Y la frase sirve para actuar, no solo para enterarse.
    expect(r.mensaje.length).toBeGreaterThan(20);
    // Esto es lo que ninguna verificación anterior podía decir: hay credencial
    // y no funciona. `providerAvailable` habría devuelto true.
    expect(r.proveedor).toBe('google');
  });

  it('dice cuál se PEDÍA cuando el respaldo eligió otro', async () => {
    // El caso del 11-10 exacto: el negocio tenía su proveedor por defecto sin
    // llave en el contenedor, y el respaldo cayó al único que la tenía.
    const r = await probarLaIa(
      { settings: { ia: { tasks: { sugerir: { provider: 'glm', model: 'z-ai/glm-5.3-flash' } } } } },
      { hayLlave: SOLO('openai'), modelPortFactory: queContesta('listo') },
    );
    expect(r.contesto).toBe(true);
    expect(r.proveedor).toBe('openai');
    expect(r.pedido).toBe('glm');
    expect(r.mensaje).toContain('glm');
  });

  it('cuando el pedido ES el que se usa, no inventa un aviso', async () => {
    const r = await probarLaIa(
      { settings: null },
      { hayLlave: SOLO('openai', 'glm', 'google', 'anthropic'), modelPortFactory: queContesta('listo') },
    );
    expect(r.pedido).toBeNull();
    expect(r.contesto).toBe(true);
  });

  it('respuesta vacía con HTTP 200 NO es «contestó» (#859)', async () => {
    // `z-ai/glm-5.3-flash` con poco tope devuelve content:null y
    // finish_reason:"length": gastó el presupuesto razonando. Contar eso como
    // éxito sería la verificación que pasa mientras la función no sirve, que
    // es el defecto entero que esto viene a sacar.
    const r = await probarLaIa(
      { settings: null },
      {
        hayLlave: SOLO('openai'),
        modelPortFactory: queContesta('   ', { tokensOut: 600, truncada: true }),
      },
    );
    expect(r.contesto).toBe(false);
    expect(r.tokensOut).toBe(600);
    expect(r.mensaje).toContain('sin texto');
    // Y dice qué hacer, que es la mitad que suele faltar.
    expect(r.mensaje).toMatch(/tope de salida|razone menos/);
  });

  it('sin ninguna credencial no gasta una llamada para descubrirlo', async () => {
    let llamadas = 0;
    const r = await probarLaIa(
      { settings: null },
      {
        hayLlave: () => false,
        modelPortFactory: () => ({
          generate: async () => {
            llamadas += 1;
            return { text: 'no debería pasar', tokensIn: 0, tokensOut: 0 };
          },
        }),
      },
    );
    expect(r.contesto).toBe(false);
    expect(r.motivo).toBe('sin_llave');
    expect(llamadas).toBe(0);
    // Nadie tiene llave, así que no hay otro al que mandar: el mensaje nombra
    // la variable que falta y NO ofrece elegir en los ajustes. Ver la prueba
    // de abajo, que es la mitad que faltaba.
    expect(r.mensaje).toContain('OPENAI_API_KEY');
    expect(r.mensaje).not.toContain('elige otro proveedor');
  });

  /**
   * El consejo tiene que poder obedecerse.
   *
   * La primera versión decía siempre «elige otro proveedor en los ajustes de
   * IA», y la corrida dentro del contenedor la pilló mintiendo justo en
   * `transcribir`: ahí no hay otro —el audio entra como file part y los
   * endpoints de texto no lo reciben (#864)—, así que mandaba a elegir entre
   * una lista de uno. Es el mismo defecto que esta función vino a sacar,
   * cometido por ella: una pantalla de diagnóstico que dice algo que no se
   * puede hacer.
   */
  it('solo ofrece elegir otro proveedor cuando de verdad hay otro que pueda', async () => {
    // Con llave en otro que SÍ puede hacer texto: se puede elegir.
    const conSalida = await probarLaIa(
      { settings: { ia: { tasks: { sugerir: { provider: 'anthropic', model: 'x' } } } } },
      { hayLlave: SOLO('openai'), modelPortFactory: queContesta('listo') },
    );
    // El respaldo ya lo movió a openai, así que ni hace falta el consejo.
    expect(conSalida.contesto).toBe(true);
    expect(conSalida.pedido).toBe('anthropic');

    // `transcribir` sin llave de google: NINGÚN otro proveedor puede hacerla.
    const sinSalida = await probarLaIa(
      { settings: null, tarea: 'transcribir' },
      { hayLlave: SOLO('openai'), modelPortFactory: queContesta('listo') },
    );
    expect(sinSalida.contesto).toBe(false);
    expect(sinSalida.motivo).toBeNull();
    expect(sinSalida.mensaje).toContain('requiere un archivo de audio');
    expect(sinSalida.mensaje).not.toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(sinSalida.mensaje).not.toContain('elige otro proveedor');
  });

  it('mide la latencia de verdad y devuelve el modelo exacto que usó', async () => {
    const r = await probarLaIa(
      { settings: null },
      {
        hayLlave: SOLO('openai'),
        modelPortFactory: queContesta('listo'),
        ahora: (() => {
          const tiempos = [5000, 9300];
          let i = 0;
          return () => tiempos[i++] ?? 9300;
        })(),
      },
    );
    expect(r.latencyMs).toBe(4300);
    expect(r.modelo).toBeTruthy();
    expect(r.mensaje).toContain('4300 ms');
  });

  it('prueba la tarea que se le pide, y una tarea inventada cae en sugerir', async () => {
    const pesada = await probarLaIa(
      { settings: null, tarea: 'configuracion_conversada' },
      { hayLlave: SOLO('openai'), modelPortFactory: queContesta('listo') },
    );
    expect(pesada.tarea).toBe('configuracion_conversada');

    const inventada = await probarLaIa(
      { settings: null, tarea: 'no_existe' as never },
      { hayLlave: SOLO('openai'), modelPortFactory: queContesta('listo') },
    );
    expect(inventada.tarea).toBe('sugerir');
  });

  it('nunca devuelve el texto crudo del proveedor como mensaje', async () => {
    const crudo = 'Error: ECONNREFUSED 10.10.20.11:443 at TLSSocket._secureSocket';
    const r = await probarLaIa(
      { settings: null },
      { hayLlave: SOLO('openai'), modelPortFactory: queFalla(crudo) },
    );
    expect(r.contesto).toBe(false);
    // Un diagnóstico es una pantalla que alguien va a compartir para pedir
    // ayuda: no puede llevar una IP interna ni un stack.
    expect(r.mensaje).not.toContain('10.10.20.11');
    expect(r.mensaje).not.toContain('TLSSocket');
  });
});
