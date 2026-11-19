import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * El script que decide con qué rol conecta la aplicación (#370).
 *
 * Es el compañero inverso de `sembrar-llaves.sh`: allá manda el panel y acá
 * manda el secreto, porque cambiar la cadena de conexión es la decisión de si
 * el aislamiento entre tenants existe, y eso se revisa en un PR. Las dos cosas
 * que este archivo sostiene, heredadas de #848/#850/#860:
 *
 *  - se corre el script DE VERDAD, con bash, y se mira el documento que sale;
 *  - los valores son contraseñas: en los mensajes tienen que salir las
 *    huellas y jamás los valores.
 */
const SCRIPT = join(__dirname, '..', '..', '..', '..', 'scripts', 'sembrar-url-app.sh');

const URL_DUENO = 'postgres://postgres.ref:secreto-dueno@pooler.supabase.com:6543/postgres';
const URL_APP = 'postgres://iaxti_app.ref:secreto-nuevo@pooler.supabase.com:6543/postgres';

function sembrar(
  documento: string,
  entorno: Record<string, string>,
): { env: string; mensajes: string } {
  const salida = execFileSync('bash', [SCRIPT, 'DATABASE_URL_APP', 'DATABASE_URL'], {
    input: documento,
    encoding: 'utf8',
    env: { ...process.env, ...entorno },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const conError = execFileSync(
    'bash',
    ['-c', `"$0" DATABASE_URL_APP DATABASE_URL 2>&1 >/dev/null`, SCRIPT],
    { input: documento, encoding: 'utf8', env: { ...process.env, ...entorno } },
  );
  return { env: salida, mensajes: conError };
}

describe('sembrar la URL del rol de aplicación en el env de Dokploy', () => {
  it('reemplaza la del panel: acá manda el secreto (#370)', () => {
    const { env, mensajes } = sembrar(`IMAGE=x\nDATABASE_URL=${URL_DUENO}\n`, {
      DATABASE_URL_APP: URL_APP,
    });
    expect(env).toContain(`DATABASE_URL=${URL_APP}`);
    expect(env).not.toContain('secreto-dueno');
    expect(env).toContain('IMAGE=x');
    // Y se ve que se cambió, sin filtrar ninguna de las dos contraseñas.
    expect(mensajes).toContain('::warning');
    expect(mensajes).toContain('Manda el SECRETO');
    expect(mensajes).not.toContain(URL_DUENO);
    expect(mensajes).not.toContain(URL_APP);
  });

  it('con la misma URL queda igual y lo dice con la huella', () => {
    const { env, mensajes } = sembrar(`DATABASE_URL=${URL_APP}\n`, {
      DATABASE_URL_APP: URL_APP,
    });
    expect(env).toBe(`DATABASE_URL=${URL_APP}\n`);
    expect(env.match(/^DATABASE_URL=/gm)).toHaveLength(1);
    expect(mensajes).toContain('es la misma que el secreto: DATABASE_URL');
    expect(mensajes).toMatch(/DATABASE_URL \([0-9a-f]{12}\)/);
  });

  it('la línea presente y VACÍA se reemplaza igual: vacío no es decisión (#850 al revés)', () => {
    const { env } = sembrar('DATABASE_URL=\n', { DATABASE_URL_APP: URL_APP });
    expect(env).toContain(`DATABASE_URL=${URL_APP}`);
    expect(env.match(/^DATABASE_URL=/gm)).toHaveLength(1);
  });

  it('sin línea DATABASE_URL la agrega al final', () => {
    const { env, mensajes } = sembrar('IMAGE=x\nREDIS_PASSWORD=r\n', {
      DATABASE_URL_APP: URL_APP,
    });
    expect(env).toBe(`IMAGE=x\nREDIS_PASSWORD=r\nDATABASE_URL=${URL_APP}\n`);
    expect(mensajes).toContain('sembrada en el env de Dokploy: DATABASE_URL (no tenía línea)');
  });

  it('con el secreto vacío no toca nada y no dice nada', () => {
    const { env, mensajes } = sembrar(`DATABASE_URL=${URL_DUENO}\n`, {
      DATABASE_URL_APP: '',
    });
    expect(env).toBe(`DATABASE_URL=${URL_DUENO}\n`);
    expect(mensajes.trim()).toBe('');
  });

  it('no duplica la línea cuando ya estaba una sola', () => {
    const { env } = sembrar(`IMAGE=x\nDATABASE_URL=${URL_DUENO}\nZERNIO_LLAVE_VOXTI=z\n`, {
      DATABASE_URL_APP: URL_APP,
    });
    expect(env.match(/^DATABASE_URL=/gm)).toHaveLength(1);
    // El resto del documento llega entero a Dokploy.
    expect(env).toContain('ZERNIO_LLAVE_VOXTI=z');
  });

  it('una URL con query y fragmento sobrevive entera', () => {
    const rara = 'postgres://iaxti_app.ref:p%40s@h:6543/db?sslmode=require&x=1#f';
    const { env } = sembrar(`DATABASE_URL=${URL_DUENO}\n`, { DATABASE_URL_APP: rara });
    expect(env).toContain(`DATABASE_URL=${rara}`);
  });
});
