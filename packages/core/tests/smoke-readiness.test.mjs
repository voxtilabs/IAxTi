import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

let directory;
let smoke;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'iaxti-smoke-ready-'));
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8'));
  smoke = workflow.jobs.deploy.steps.find(step => step.name === 'Smoke').run;
  // Se ejecuta el shell real del workflow; solo la red y las esperas son locales.
  writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(directory, 'curl'), `#!/bin/bash
set -eu
url="\${!#}"
code=200
if [[ "$url" == */ready ]]; then
  n=0
  [ ! -f "$COUNTER" ] || read -r n < "$COUNTER"
  n=$((n+1))
  echo "$n" > "$COUNTER"
  if [ "$MODE" = persistent ] || [ "$n" -le 2 ]; then code=503; fi
fi
format=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -w ]; then format="$2"; break; fi
  shift
done
estado=$([ "$code" = 200 ] && echo ok || echo degraded)
# Con printf y no con comillas escapadas: este archivo se escribe desde una
# plantilla de JavaScript, donde \" se convierte en " y el shell recibe una
# cadena partida. Se me rompió así, y printf no necesita comillas dentro.
cuerpo=$(printf '{%sstatus%s:%s%s%s' '"' '"' '"' "$estado" '"')
# El SHA solo cuando la prueba lo pide: así se simula tanto un /health que no lo
# informa (el de antes de #565) como uno que informa otro build.
if [ -n "\${FAKE_SHA:-}" ] && [[ "$url" == */health ]]; then
  cuerpo=$(printf '%s,%ssha%s:%s%s%s' "$cuerpo" '"' '"' '"' "$FAKE_SHA" '"')
fi
cuerpo="$cuerpo}"
if [[ "$format" == *'\\n'* ]]; then
  printf '%s\\n%s' "$cuerpo" "$code"
elif [ -n "$format" ]; then
  printf '%s' "$code"
else
  # Sin -w: solo el cuerpo. Es como lee el SHA la comprobación de #565.
  printf '%s' "$cuerpo"
fi
`, { mode: 0o755 });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(mode, extra = {}) {
  const counter = join(directory, mode + (extra.FAKE_SHA ?? '') + (extra.SHA ?? ''));
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', smoke], {
    env: {
      ...process.env,
      BASE: 'http://prueba.invalid',
      PATH: `${directory}:${process.env.PATH}`,
      COUNTER: counter,
      MODE: mode,
      ...extra,
    },
    encoding: 'utf8', timeout: 10_000,
  });
  return { ...result, checks: Number(readFileSync(counter, 'utf8')) };
}

describe('smoke espera dependencias reales (#17, #254)', () => {
  it('salud 200 con readiness 503 al arrancar se recupera sin un rojo prematuro', () => {
    const result = run('recover');
    expect(result.status).toBe(0);
    expect(result.checks).toBeGreaterThanOrEqual(4); // dos fallos, listo y comprobación final.
    expect(result.stdout).toContain('--- /ready -> 200');
  });

  it('salud 200 no oculta readiness que permanece en 503', () => {
    const result = run('persistent');
    expect(result.status).toBe(1);
    expect(result.checks).toBeGreaterThanOrEqual(72);
    expect(result.stdout).toContain('--- /ready -> 503');
  });

  it('mide la ventana sin atender y la deja escrita (#254)', () => {
    // La espera larga estaba muda: si mañana la app tarda el doble por un
    // bug, el paso la aguanta igual y nadie se entera. El número tiene que
    // salir en cada despliegue, aunque todo haya ido bien.
    const result = run('recover');
    expect(result.stdout).toMatch(/Ventana sin atender: \d+s/);
  });

  it('pasarse del presupuesto avisa, pero no tumba un despliegue sano', () => {
    // Fallarlo dejaría staging desplegado con el CI en rojo, que es la peor
    // combinación para leer: parece que no se desplegó y sí se desplegó.
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', smoke], {
      env: {
        ...process.env,
        BASE: 'http://prueba.invalid',
        PATH: `${directory}:${process.env.PATH}`,
        COUNTER: join(directory, 'presupuesto'),
        MODE: 'recover',
        // -1 y no 0: el `sleep` está anulado en este test, así que la
        // espera medida es 0 segundos y no superaría un presupuesto de 0.
        PRESUPUESTO_SEG: '-1',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::');
  });
});

/**
 * Que lo que quedó vivo sea lo que se desplegó (#565).
 *
 * Dokploy puede decir «done» sobre la imagen anterior —si el pull falló, si el
 * contenedor viejo nunca murió— y hasta ahora el smoke pasaba igual, porque la
 * app de antes contesta `/health` y `/ready` perfectamente bien. Un despliegue
 * que no desplegó nada se leía como bueno.
 */
describe('el smoke verifica QUÉ build quedó vivo (#565)', () => {
  const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

  it('el SHA que contesta coincide con el desplegado: pasa y lo dice', () => {
    const result = run('recover', { SHA, FAKE_SHA: SHA.slice(0, 12) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Build vivo: abcdef123456');
  });

  it('está corriendo OTRA imagen: falla, aunque /health y /ready contesten 200', () => {
    const result = run('recover', { SHA, FAKE_SHA: '999999999999' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('está corriendo otra imagen');
  });

  it('sin SHA en el entorno no se verifica nada y no se inventa un rojo', () => {
    // Este mismo paso se ejecuta de verdad en esta prueba, y ahí no hay commit
    // desplegado: comparar contra la nada y fallar sería un rojo sin significado.
    const result = run('recover');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Sin SHA en el entorno');
  });

  it('un /health que no informa el SHA FALLA: es una imagen vieja (#573)', () => {
    // Era un aviso, y el aviso se dio justo en el caso que más importa: el
    // despliegue de 34ce61e dijo «done» y staging siguió sirviendo una imagen
    // anterior a #566 — la que no informa el SHA. Una comprobación de imagen
    // vieja que se calla cuando la imagen es vieja no comprueba nada.
    const result = run('recover', { SHA });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('imagen anterior');
    expect(result.stdout).toContain('#573');
  });
});
