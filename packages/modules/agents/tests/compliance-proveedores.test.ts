import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TASK_MODELS, PROVIDERS, proveedorPermitidoParaTarea } from '../domain/config';
import { ENV_KEYS } from '../application/models';

/**
 * Cada proveedor de IA elegible tiene su fila de transferencia internacional
 * (#81, Ley 21.719 · ISO 27701 7.5).
 *
 * `anthropic` estaba en `PROVIDERS` desde siempre —cualquier tenant lo podía
 * poner como proveedor de una tarea— y **no tenía fila** en la matriz de
 * compliance. Gemini, Zavu, Supabase y R2 sí. El texto de las conversaciones
 * sale hacia el proveedor elegido igual en los cuatro casos.
 *
 * Nadie lo notó porque agregar un proveedor es una línea en un array y la
 * matriz vive en otro archivo. Esto los mira a los dos.
 */
const MATRIZ = join(__dirname, '../../../../docs/COMPLIANCE_BASELINE.md');

/** Cómo se llama cada proveedor en la matriz, que está escrita para leerse. */
const NOMBRE_EN_LA_MATRIZ: Record<string, string> = {
  google: 'Google Gemini',
  anthropic: 'Anthropic',
  glm: 'GLM',
  openai: 'OpenAI',
};

describe('la matriz de compliance y los proveedores de IA', () => {
  it('todo proveedor elegible tiene su fila de transferencia internacional', () => {
    const texto = readFileSync(MATRIZ, 'utf8');
    for (const proveedor of PROVIDERS) {
      const nombre = NOMBRE_EN_LA_MATRIZ[proveedor];
      expect(nombre, `falta el nombre legible de "${proveedor}" en este test`).toBeTruthy();
      const fila = new RegExp(`\\| Transferencia internacional · ${nombre}[^|]*\\|`);
      expect(
        texto,
        `"${proveedor}" es elegible y no tiene fila de transferencia internacional en COMPLIANCE_BASELINE.md`,
      ).toMatch(fila);
    }
  });

  it('ninguna fila afirma cumplimiento ISO', () => {
    const texto = readFileSync(MATRIZ, 'utf8');
    // SPEC §30: la arquitectura es auditable; la certificación es otra cosa.
    // Un "cumple ISO" en este documento es lo que después aparece en una
    // presentación comercial.
    const filas = texto.split('\n').filter((l) => l.startsWith('|'));
    for (const fila of filas) {
      expect(fila.toLowerCase(), `una fila afirma cumplimiento: ${fila.slice(0, 60)}`).not.toMatch(
        /cumple (con )?(la )?iso|certificad[oa] iso|iso[- ]?\d+ certificad/,
      );
    }
  });
});

/**
 * OpenAI quedó elegible el 11-10 (#842), y estas dos fijan las dos cosas que
 * NO son políticas sino hechos del adaptador.
 */
describe('openai como cuarto proveedor (#842)', () => {
  it('está en PROVIDERS y tiene su variable', () => {
    expect(PROVIDERS).toContain('openai');
    expect(ENV_KEYS.openai).toBe('OPENAI_API_KEY');
  });

  it('`transcribir` NO pasa por openai: es capacidad, no preferencia', () => {
    // El adaptador compatible habla `/chat/completions` y la transcripción de
    // IAxTi manda el audio como file part. OpenAI sí sabe transcribir, por
    // otra API — dárselo a esta tarea fallaría en cada audio recibido.
    expect(proveedorPermitidoParaTarea('openai', 'transcribir')).toBe(false);
    // Y las de texto sí, que es el punto de haberlo agregado.
    for (const tarea of ['sugerir', 'responder', 'clasificar', 'analizar'] as const) {
      expect(proveedorPermitidoParaTarea('openai', tarea)).toBe(true);
    }
  });

  /**
   * Esta guarda decía «openai NO es el proveedor por defecto». Desde el 12-10
   * lo es, por decisión del dueño, así que afirmar lo contrario sería una
   * prueba protegiendo una decisión vieja — justo lo que no puede pasar.
   *
   * Lo que la guarda cuidaba de verdad era otra cosa: que por dónde pasan los
   * datos de los clientes de nuestros clientes no se mueva **sin que nadie lo
   * decida y lo escriba**. Eso se puede seguir exigiendo, y es más fuerte que
   * fijar un nombre: el proveedor por defecto tiene que tener su fila en la
   * matriz de compliance, diciendo que es el defecto.
   */
  it('el proveedor por DEFECTO tiene su fila en la matriz, y dice que es el defecto', () => {
    const matriz = readFileSync(MATRIZ, 'utf8');
    const porDefecto = [...new Set(Object.values(DEFAULT_TASK_MODELS).map((m) => m.provider))];
    // Anti-vacuidad: si esto quedara vacío, el bucle de abajo no mediría nada.
    expect(porDefecto.length).toBeGreaterThan(0);

    for (const p of porDefecto) {
      const fila = matriz
        .split('\n')
        .find((l) => l.startsWith('|') && new RegExp(`\\b${NOMBRE_EN_LA_MATRIZ[p]}\\b`, 'i').test(l));
      expect(
        fila,
        `${p} es proveedor por defecto de alguna tarea y no tiene fila en COMPLIANCE_BASELINE.md. ` +
          'El texto de las conversaciones de todos los negocios sale hacia allá: eso se escribe.',
      ).toBeTruthy();
      expect(
        /por defecto/i.test(fila!),
        `La fila de ${p} no dice que es el proveedor por defecto. Una fila que no distingue ` +
          '«elegible» de «por defecto» no sirve para decidir nada.',
      ).toBe(true);
    }
  });
});
