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
if [[ "$format" == *'\\n'* ]]; then
  printf '{"status":"%s"}\\n%s' "$([ "$code" = 200 ] && echo ok || echo degraded)" "$code"
elif [ -n "$format" ]; then
  printf '%s' "$code"
fi
`, { mode: 0o755 });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(mode) {
  const counter = join(directory, mode);
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', smoke], {
    env: { ...process.env, BASE: 'http://prueba.invalid', PATH: `${directory}:${process.env.PATH}`, COUNTER: counter, MODE: mode },
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
});
