import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Guarda: una familia que rompe al subir no viaja en el PR de rutina (#978).
 *
 * `dependabot.yml` ya separaba mayores de menores (#881) porque un PR con tres
 * migraciones adentro no se puede mergear y envejece igual que la dependencia
 * que no se actualizó. Pero esa separación mira el NIVEL DE SEMVER, y con mayor
 * 0 el nivel miente: `@opentelemetry/sdk-node` 0.54.2 → 0.222.0 es «minor» para
 * Dependabot y es ciento sesenta y ocho versiones de salto. Así llegó #973 —once
 * parches inofensivos y cuatro paquetes de OpenTelemetry— y se quedó en rojo
 * pidiendo una migración de `core`, `sdk-logs`, `Resource` y `IMetricReader`,
 * más subir `@sentry/opentelemetry` de mayor porque tiene peer sobre OTel 1.x.
 *
 * Lo que esta guarda cuida no es el archivo: es que el grupo de rutina siga
 * siendo mergeable. Si alguien agrega un patrón a `telemetria` y se olvida de
 * excluirlo de los otros grupos de producción, la familia vuelve a viajar con
 * los parches y el PR semanal vuelve a nacer rojo.
 */
describe('las migraciones no viajan con los parches (#978)', () => {
  const RAIZ = join(__dirname, '..', '..', '..');
  const config = parse(readFileSync(join(RAIZ, '.github', 'dependabot.yml'), 'utf8'));
  const npm = config.updates.find(
    (u: { 'package-ecosystem': string; directory: string }) =>
      u['package-ecosystem'] === 'npm' && u.directory === '/',
  );

  it('la familia que pide migración tiene su propio grupo', () => {
    expect(npm.groups.telemetria.patterns).toContain('@opentelemetry/*');
    // Sin nivel de semver: con mayor 0, separar por nivel es lo que no sirvió.
    expect(npm.groups.telemetria['update-types']).toBeUndefined();
  });

  it('ningún otro grupo de producción se la lleva puesta', () => {
    const suyos: string[] = npm.groups.telemetria.patterns;
    for (const nombre of Object.keys(npm.groups)) {
      if (nombre === 'telemetria') continue;
      const grupo = npm.groups[nombre];
      // Los de seguridad sí la llevan, y está bien: ahí el riesgo es el
      // contrario —quedarse en la versión vulnerable— y se decide a mano.
      if (grupo['applies-to'] === 'security-updates') continue;
      if (grupo['dependency-type'] !== 'production') continue;
      expect(
        grupo['exclude-patterns'] ?? [],
        `El grupo \`${nombre}\` se lleva la familia de telemetría. Con mayor 0 ` +
          'un «minor» rompe, así que ese PR nace rojo y se queda ahí (#973).',
      ).toEqual(expect.arrayContaining(suyos));
    }
  });
});
