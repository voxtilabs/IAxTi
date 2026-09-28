import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Forzar la recreación cuando el contenedor no tomó la imagen (#652).
 *
 * Vive en un script con su prueba por la lección de #571: la rama que no se
 * prueba es justo la que se estrena. Y acá las ramas importan más que de
 * costumbre, porque una de ellas **detiene staging**. Que se dispare cuando no
 * corresponde es una caída que nadie pidió.
 */

const GUION = new URL('../../../scripts/forzar-recreacion.sh', import.meta.url).pathname;

let directorio;
beforeAll(() => {
  directorio = mkdtempSync(join(tmpdir(), 'iaxti-forzar-'));
  writeFileSync(join(directorio, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // El curl de mentira: anota cada POST a Dokploy y contesta /health con el SHA
  // que la prueba pida. Con CAMBIA_EN se simula lo que pasa de verdad — el
  // contenedor viejo sigue contestando hasta que el nuevo lo reemplaza.
  writeFileSync(join(directorio, 'curl'), `#!/bin/bash
set -eu
url="\${!#}"
if [[ "$url" == *compose.stop* ]]; then echo "STOP" >> "$LLAMADAS"; exit 0; fi
if [[ "$url" == *compose.deploy* ]]; then echo "DEPLOY" >> "$LLAMADAS"; exit 0; fi
if [[ "$url" == */health ]]; then
  n=0
  [ ! -f "$CONTADOR" ] || read -r n < "$CONTADOR"
  n=$((n+1)); echo "$n" > "$CONTADOR"
  # Respuestas malas a pedido (#667): son las que tumbaban el paso entero.
  if [ -n "\${SALUD_MALA:-}" ]; then
    case "$SALUD_MALA" in
      html)   printf '%s' '<html>502 Bad Gateway</html>' ;;
      vacia)  printf '' ;;
      numero) printf '%s' '200' ;;
      caida)  exit 7 ;;
    esac
    exit 0
  fi
  sha="$SHA_VIVO"
  if [ -n "\${SHA_DESPUES:-}" ] && [ "$n" -gt "\${CAMBIA_EN:-1}" ]; then sha="$SHA_DESPUES"; fi
  if [ -z "$sha" ]; then printf '%s' '{"status":"ok"}'; else printf '{"sha":"%s"}' "$sha"; fi
  exit 0
fi
exit 0
`, { mode: 0o755 });
});
afterAll(() => rmSync(directorio, { recursive: true, force: true }));

function correr(nombre, extra = {}) {
  const contador = join(directorio, `c-${nombre}`);
  const llamadas = join(directorio, `l-${nombre}`);
  rmSync(contador, { force: true });
  writeFileSync(llamadas, '');
  const r = spawnSync('bash', [GUION], {
    env: {
      ...process.env,
      PATH: `${directorio}:${process.env.PATH}`,
      DOKPLOY_URL: 'http://dokploy.invalid',
      DOKPLOY_API_KEY: 'llave-de-mentira',
      COMPOSE_ID: 'cmp-1',
      BASE: 'http://staging.invalid',
      SHA: 'nuevo1234567890abcdef',
      SHA_VIVO: '',
      CONTADOR: contador,
      LLAMADAS: llamadas,
      PASO_SEG: '1',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { ...r, llamadas: readFileSync(llamadas, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('forzar la recreación (#652)', () => {
  it('si el contenedor YA tomó la imagen, no toca nada', () => {
    const r = correr('ok', { SHA_VIVO: 'nuevo1234567' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // Lo más importante de esta prueba: NO se detuvo el stack. Un stop de más
    // es una caída de staging que nadie pidió.
    expect(r.llamadas).toEqual([]);
    expect(r.stdout).toContain('ya tomó la imagen');
  });

  it('si atiende otra imagen, la fuerza: stop y después deploy', () => {
    const r = correr('forzar', {
      SHA_VIVO: 'viejo0000000',
      SHA_DESPUES: 'nuevo1234567',
      CAMBIA_EN: '2',
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // En ese orden, y ninguno de más. `compose.start` no aparece a propósito:
    // corre con `env -i` y sin el archivo de variables, así que ni IMAGE tiene
    // valor y el stack no levanta.
    expect(r.llamadas).toEqual(['STOP', 'DEPLOY']);
    expect(r.stdout).toContain('EL CONTENEDOR NO TOMÓ LA IMAGEN');
    expect(r.stdout).toContain('viejo0000000');
    expect(r.stdout).toContain('Listo: ahora atiende nuevo1234567');
  });

  it('si después de forzarlo sigue sin tomarla, FALLA', () => {
    const r = correr('sigue-mal', { SHA_VIVO: 'viejo0000000', ESPERA_RECREAR_SEG: '3' });
    expect(r.status).toBe(1);
    expect(r.llamadas).toEqual(['STOP', 'DEPLOY']);
    expect(r.stdout).toContain('sigue sin tomar la imagen');
    // Y dice los dos, que es lo que alguien necesita para ir al panel.
    expect(r.stdout).toContain('viejo0000000');
    expect(r.stdout).toContain('nuevo1234567890abcdef');
  });

  it('un /health que no informa el SHA cuenta como "no la tomó"', () => {
    // Es una imagen anterior a #566, que es exactamente el caso de #573.
    const r = correr('sin-sha', { SHA_VIVO: '', SHA_DESPUES: 'nuevo1234567', CAMBIA_EN: '1' });
    expect(r.status).toBe(0);
    expect(r.llamadas).toEqual(['STOP', 'DEPLOY']);
    expect(r.stdout).toContain('<no informa el SHA>');
  });

  /**
   * Un `/health` ilegible NO tumba el paso (#667).
   *
   * La versión anterior hacía `curl … | jq -r '.sha // empty'` con
   * `set -euo pipefail`: cualquier respuesta que `jq` no supiera leer mataba el
   * despliegue entero. Pasó de verdad — un deploy que terminó bien, con la
   * imagen ya rotada, quedó en rojo por esto. Y va contra lo que este mismo
   * script decidió: «no pude leer qué build está vivo» es un estado que sabe
   * manejar, no un motivo para abortar.
   */
  describe('un /health que no se puede leer (#667)', () => {
    for (const [forma, como] of [
      ['html', 'una página de error del proxy'],
      ['vacia', 'un cuerpo vacío'],
      ['numero', 'algo que no es JSON'],
      ['caida', 'curl que ni contesta'],
    ]) {
      it(`${como} se trata como «no informa el SHA», y se fuerza igual`, () => {
        const r = correr(`mala-${forma}`, { SHA_VIVO: '', SALUD_MALA: forma, ESPERA_RECREAR_SEG: '3' });
        // Falla al final porque nunca aparece el build nuevo, que es correcto.
        // Lo que NO puede pasar es morir en el primer `jq`.
        expect(r.stdout, r.stderr).toContain('<no informa el SHA>');
        expect(r.llamadas).toEqual(['STOP', 'DEPLOY']);
        expect(r.stderr).not.toContain('jq');
      });
    }
  });

  it('sin SHA en el entorno no hace NADA: el script corre de verdad en esta prueba', () => {
    const r = correr('sin-entorno', { SHA: '' });
    expect(r.status).toBe(0);
    expect(r.llamadas).toEqual([]);
    expect(r.stdout).toContain('no se verifica');
  });

  it('sin BASE tampoco, y por el mismo motivo', () => {
    const r = correr('sin-base', { BASE: '' });
    expect(r.status).toBe(0);
    expect(r.llamadas).toEqual([]);
  });
});
