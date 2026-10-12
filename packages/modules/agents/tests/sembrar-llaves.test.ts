import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * El script que decide si staging tiene IA (#860).
 *
 * Esto antes era un bloque de bash dentro del workflow, y por eso se rompió
 * tres veces seguidas sin que ninguna prueba dijera nada: #848 (escrito a mano
 * para un solo proveedor), #850 (una línea vacía contaba como «ya está») y
 * #860 (un valor equivocado en el panel es invisible). Las tres se podían
 * cazar corriendo el bloque; ninguna, leyéndolo.
 *
 * Se corre el script DE VERDAD, con bash, y se mira el documento que sale.
 */
const SCRIPT = join(__dirname, '..', '..', '..', '..', 'scripts', 'sembrar-llaves.sh');

function sembrar(
  documento: string,
  entorno: Record<string, string>,
  vars: string[],
): { env: string; mensajes: string } {
  const salida = execFileSync('bash', [SCRIPT, ...vars], {
    input: documento,
    encoding: 'utf8',
    env: { ...process.env, ...entorno },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // `execFileSync` no devuelve stderr y acá hace falta, así que se vuelve a
  // correr capturándolo todo junto. Es un script de dos líneas: cuesta nada.
  const conError = execFileSync(
    'bash',
    ['-c', `"$0" "$@" 2>&1 >/dev/null`, SCRIPT, ...vars],
    { input: documento, encoding: 'utf8', env: { ...process.env, ...entorno } },
  );
  return { env: salida, mensajes: conError };
}

describe('sembrar las llaves en el env de Dokploy', () => {
  it('agrega la llave que falta', () => {
    const { env, mensajes } = sembrar('IMAGE=x\nOTRA=1\n', { GLM_API_KEY: 'llave-buena' }, [
      'GLM_API_KEY',
    ]);
    expect(env).toContain('GLM_API_KEY=llave-buena');
    expect(mensajes).toContain('sembrada en el env de Dokploy: GLM_API_KEY');
    // Lo que ya estaba sigue estando: esto se manda tal cual a Dokploy.
    expect(env).toContain('IMAGE=x');
    expect(env).toContain('OTRA=1');
  });

  it('completa la que está presente y VACÍA, y no la deja dos veces (#850)', () => {
    const { env } = sembrar('GLM_API_KEY=\nIMAGE=x\n', { GLM_API_KEY: 'llave-buena' }, [
      'GLM_API_KEY',
    ]);
    expect(env).toContain('GLM_API_KEY=llave-buena');
    expect(env.match(/^GLM_API_KEY=/gm)).toHaveLength(1);
  });

  it('con valor en el panel manda el panel, y lo dice', () => {
    const { env, mensajes } = sembrar('GLM_API_KEY=la-del-panel\n', { GLM_API_KEY: 'la-del-panel' }, [
      'GLM_API_KEY',
    ]);
    expect(env).toContain('GLM_API_KEY=la-del-panel');
    expect(mensajes).toContain('es la misma que el secreto: GLM_API_KEY');
  });

  it('avisa cuando el panel y el secreto NO son la misma llave (#860)', () => {
    const { env, mensajes } = sembrar('GLM_API_KEY=la-vieja\n', { GLM_API_KEY: 'la-nueva' }, [
      'GLM_API_KEY',
    ]);
    // Manda el panel: eso no cambia.
    expect(env).toContain('GLM_API_KEY=la-vieja');
    expect(env).not.toContain('la-nueva');
    // Lo que cambia es que se ve. Y es un `::warning`, no una línea suelta:
    // una línea suelta en un log de 400 líneas no la lee nadie.
    expect(mensajes).toContain('::warning');
    expect(mensajes).toContain('NO es la del secreto de GitHub');
    // Y ninguna de las dos llaves sale en el mensaje. Un aviso que filtra la
    // llave es peor que no tener aviso.
    expect(mensajes).not.toContain('la-vieja');
    expect(mensajes).not.toContain('la-nueva');
  });

  it('las huellas de dos llaves distintas son distintas, y la misma llave da la misma', () => {
    const uno = sembrar('GLM_API_KEY=a\n', { GLM_API_KEY: 'b' }, ['GLM_API_KEY']).mensajes;
    const dos = sembrar('GLM_API_KEY=a\n', { GLM_API_KEY: 'c' }, ['GLM_API_KEY']).mensajes;
    const huellas = (t: string) => [...t.matchAll(/=([0-9a-f]{12}) /g)].map((m) => m[1]);
    const [panel1, secreto1] = huellas(uno);
    const [panel2, secreto2] = huellas(dos);
    expect(panel1).toBe(panel2); // mismo panel, misma huella
    expect(secreto1).not.toBe(secreto2); // secreto distinto, huella distinta
    expect(panel1).not.toBe(secreto1);
  });

  it('sin secreto puesto no toca nada: un secreto vacío no es una llave', () => {
    const { env, mensajes } = sembrar('IMAGE=x\n', { GLM_API_KEY: '' }, ['GLM_API_KEY']);
    expect(env).not.toContain('GLM_API_KEY');
    expect(mensajes.trim()).toBe('');
  });

  it('recorre la lista completa de proveedores que se le pasa', () => {
    const vars = ['GLM_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];
    const { env } = sembrar(
      'IMAGE=x\n',
      { GLM_API_KEY: 'g', OPENAI_API_KEY: 'o', GOOGLE_GENERATIVE_AI_API_KEY: 'gg' },
      vars,
    );
    for (const v of vars) expect(env).toContain(`${v}=`);
  });
});
