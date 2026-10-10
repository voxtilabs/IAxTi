import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * La espera del despliegue, con sus TRES salidas (#571).
 *
 * La primera versión de «un deploy fallido dice por qué» (#565) cubría la rama de
 * `error` y no la del timeout. El despliegue que la estrenó falló justo por
 * timeout, así que el arreglo no se activó: dos caminos a la misma salida, uno
 * arreglado. Por eso la espera salió del `run:` a un script — dentro de cuarenta
 * líneas de YAML no se puede probar, y lo que no se prueba tiene una rama muerta.
 */

const GUION = new URL('../../../scripts/esperar-deploy.sh', import.meta.url).pathname;

let directorio;
beforeAll(() => {
  directorio = mkdtempSync(join(tmpdir(), 'iaxti-esperar-'));
  // `sleep` instantáneo: el script espera de a 10 s y la prueba no va a esperar.
  writeFileSync(join(directorio, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(directorio, 'curl'), `#!/bin/bash
set -eu
url="\${!#}"
if [[ "$url" == *deployment.all* ]]; then
  # Los campos estructurados que devuelve Dokploy, con uno de sobra para
  # comprobar que se recortan a tres.
  cuerpo='[{"createdAt":"2026-09-26T15:00:00Z","status":"error","title":"docker compose up","errorMessage":"no such image: ghcr.io/voxtilabs/iaxti:abc"},{"createdAt":"2026-09-26T14:00:00Z","status":"done","title":"ok"},{"createdAt":"2026-09-26T13:00:00Z","status":"done","title":"ok"},{"createdAt":"2026-09-26T12:00:00Z","status":"done","title":"NO DEBERIA SALIR"}]'
  # Desde #661 el script pide el código HTTP con -w, porque «no se pudo leer el
  # detalle» tapaba cuatro causas distintas. CODIGO_DETALLE deja que cada
  # prueba elija cuál simular; sin él, 200 y el cuerpo de siempre.
  codigo="\${CODIGO_DETALLE:-200}"
  if [ "$codigo" != 200 ]; then cuerpo=''; fi
  if [ -n "\${CUERPO_NO_JSON:-}" ]; then cuerpo='<html>Cloudflare Access</html>'; fi
  printf '%s\n%s' "$cuerpo" "$codigo"
  exit 0
fi
n=0
[ ! -f "$CONTADOR" ] || read -r n < "$CONTADOR"
n=$((n+1))
echo "$n" > "$CONTADOR"
estado=running
if [ "$MODO" = listo ] && [ "$n" -ge 2 ]; then estado=done; fi
if [ "$MODO" = falla ] && [ "$n" -ge 2 ]; then estado=error; fi
# Desde #573 el sondeo pide el codigo HTTP con -w, porque un 502 transitorio de
# Cloudflare mataba el script entero bajo set -e con un despliegue ya aplicado.
# El curl de mentira tiene que contestar como el de verdad: si se come el -w, el
# cuerpo se lee como si fuera el codigo.
#
# SONDEO_MALO deja que cada prueba simule la respuesta ilegible en el sondeo que
# quiera: 502 el error de proxy, html un cuerpo que no es JSON, caida que curl
# no conteste nada. (Sin comillas invertidas aca: esto vive DENTRO de un
# template literal de JS y una sola lo corta.)
if [ "\${SONDEO_MALO:-}" = "$n" ] || [ "\${SONDEO_MALO:-}" = todos ]; then
  case "\${FORMA_MALA:-502}" in
    html)  printf '<html>Cloudflare Access</html>\n200' ;;
    caida) exit 7 ;;
    *)     printf '\n502' ;;
  esac
  exit 0
fi
printf '{"composeStatus":"%s"}\n200' "$estado"
`, { mode: 0o755 });
});
afterAll(() => rmSync(directorio, { recursive: true, force: true }));

function correr(modo, extra = {}) {
  // El contador se deriva de TODO lo que distingue a la corrida, no solo del
  // modo: con dos pruebas que comparten nombre de archivo, la segunda empieza
  // donde terminó la primera y el sondeo que se quería simular ya pasó. Me
  // costó dos pruebas en rojo que decían que el script no imprimía algo que sí
  // imprime.
  const contador = join(
    directorio,
    [modo, ...Object.entries(extra).map(([k, v]) => `${k}-${v}`)].join('_'),
  );
  return spawnSync('bash', [GUION], {
    env: {
      ...process.env,
      PATH: `${directorio}:${process.env.PATH}`,
      DOKPLOY_URL: 'http://dokploy.invalid',
      COMPOSE_ID: 'compose-de-prueba',
      CONTADOR: contador,
      MODO: modo,
      // Tres sondeos de a un segundo: suficiente para las tres ramas.
      ESPERA_DEPLOY_SEG: '3',
      PASO_SEG: '1',
      ...extra,
    },
    encoding: 'utf8', timeout: 15_000,
  });
}

describe('esperar-deploy.sh (#571)', () => {
  it('cuando termina, sale bien y dice cuánto tardó', () => {
    const r = correr('listo');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Deploy aplicado en');
  });

  /**
   * Un sondeo ilegible no es un despliegue fallido (#573).
   *
   * Esto era `curl -fsS … | jq` pelado bajo `set -euo pipefail`. Un 502 de
   * Cloudflare Access —pasó el 26/09 y está documentado en el workflow—
   * abortaba el script: el paso salía 1, el Smoke nunca corría, y staging SÍ
   * había quedado desplegado. CI rojo sobre un despliegue sano, que este
   * repositorio declara la peor combinación para leer.
   *
   * Y lo irónico: `detalle_del_despliegue` ya se había blindado para esto en
   * #661. La copia que de verdad decidía quedó frágil — el patrón de #675 otra
   * vez.
   */
  it.each([
    ['un 502 de Cloudflare', '502'],
    ['un cuerpo que no es JSON', 'html'],
    ['curl que no contesta nada', 'caida'],
  ])('%s en el primer sondeo no mata la espera', (_que, forma) => {
    const r = correr('listo', { SONDEO_MALO: '1', FORMA_MALA: forma, ESPERA_DEPLOY_SEG: '5' });
    // Sale BIEN: el sondeo 2 ve el `done` y el despliegue se declara aplicado.
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Deploy aplicado en');
    // Y lo dice, en vez de callar: un sondeo perdido es información.
    expect(r.stdout).toContain('sondeo ilegible');
  });

  it('si NINGÚN sondeo se puede leer, se pasa del presupuesto y lo dice', () => {
    // La otra mitad: tolerar un sondeo malo no puede volverse tolerar todos.
    // Si nunca se pudo hablar con Dokploy, eso no es un deploy aplicado.
    const r = correr('listo', { SONDEO_MALO: 'todos', ESPERA_DEPLOY_SEG: '3' });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('Deploy aplicado');
  });

  it('cuando Dokploy reporta error, lo dice y trae el detalle', () => {
    const r = correr('falla');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Dokploy reporta ERROR');
    // El motivo de verdad, que es lo que antes había que ir a buscar al panel.
    expect(r.stdout).toContain('no such image');
  });

  it('cuando se pasa del presupuesto, NO dice que falló: dice que se pasó', () => {
    // Esta es la rama que faltaba. Seguir en «running» y fallar son cosas
    // distintas, y llamarlas igual es lo que hace que nadie mire.
    const r = correr('nunca');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('sigue en "running"');
    expect(r.stdout).toContain('presupuesto 3s');
    expect(r.stdout).not.toContain('reporta ERROR');
    // Y trae el MISMO detalle que la otra salida, que es el arreglo de #571.
    expect(r.stdout).toContain('Lo que informa Dokploy');
    expect(r.stdout).toContain('no such image');
  });

  it('el detalle se recorta a los tres últimos despliegues', () => {
    // Un volcado largo en el log de Actions no lo lee nadie, y acá lo que sirve
    // es el último.
    const r = correr('falla');
    expect(r.stdout).not.toContain('NO DEBERIA SALIR');
  });

  it('no vuelca el log crudo del despliegue', () => {
    // La salida de un `compose up` puede arrastrar nombres y valores del
    // entorno, y este log lo lee cualquiera con acceso al repo.
    const r = correr('falla');
    expect(r.stdout).not.toMatch(/deployment\.all\?|x-api-key|CF-Access/);
  });

  /**
   * Cuando el detalle NO se puede leer, decir por qué (#661).
   *
   * Antes las cuatro causas terminaban en la misma frase —«no se pudo leer el
   * detalle; queda el panel de Dokploy»— y eso apareció de verdad el 27/09, dos
   * veces seguidas, en el único momento en que ese texto tenía que servir: el
   * deploy ya había fallado y esto era lo que quedaba para saber por qué.
   */
  describe('cuando el detalle no se puede leer, dice por qué', () => {
    it('404 es «esa ruta no existe en esta versión de Dokploy»', () => {
      const r = correr('falla', { CODIGO_DETALLE: '404' });
      expect(r.stdout).toContain('404');
      expect(r.stdout).toContain('esa ruta no existe');
      expect(r.stdout).not.toContain('queda el panel');
    });

    it('401 y 403 son un permiso, y lo dicen', () => {
      for (const codigo of ['401', '403']) {
        const r = correr('falla', { CODIGO_DETALLE: codigo });
        expect(r.stdout, codigo).toContain('no alcanza para deployment.all');
      }
    });

    it('sin respuesta se distingue de una respuesta mala', () => {
      const r = correr('falla', { CODIGO_DETALLE: '000' });
      expect(r.stdout).toContain('sin respuesta');
      expect(r.stdout).toContain('Cloudflare Access');
    });

    it('un 200 que no es JSON se nombra: suele ser una pantalla de Access', () => {
      const r = correr('falla', { CUERPO_NO_JSON: '1' });
      expect(r.stdout).toContain('no es JSON');
      // Y no se publica el cuerpo, que es la regla de toda esta función.
      expect(r.stdout).not.toContain('<html>');
    });

    it('y el 200 bueno sigue mostrando el detalle de siempre', () => {
      const r = correr('falla');
      expect(r.stdout).toContain('no such image');
    });
  });

  it('falta la configuración: se queja en vez de esperar quince minutos', () => {
    const r = spawnSync('bash', [GUION], {
      env: { ...process.env, PATH: `${directorio}:${process.env.PATH}`, DOKPLOY_URL: '' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('falta DOKPLOY_URL');
  });
});
