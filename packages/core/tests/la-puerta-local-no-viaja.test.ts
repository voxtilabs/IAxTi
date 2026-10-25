import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La puerta del login local (#1047) no viaja a ningún despliegue.
 *
 * /entrar-local y el servicio auth-local existen para que una persona entre
 * al panel LOCAL sin Supabase. Son una puerta firmadora de identidades: si
 * cualquiera de sus piezas llegara a staging o producción, alguien podría
 * fabricarse una sesión de cualquier usuario del seed. Las cerraduras de
 * runtime existen (el flag, el IAXTI_ENV, el server que se niega a arrancar);
 * esta guarda cuida que NI SIQUIERA se declaren las piezas allá — la clase de
 * error que una revisión de PR deja pasar porque «es solo una variable más».
 */

const RAIZ = join(__dirname, '..', '..', '..');

describe('la puerta local no viaja (#1047)', () => {
  it('los compose de Dokploy no declaran ni el flag ni el servicio', () => {
    const dokploy = join(RAIZ, 'infra', 'dokploy');
    const composes = readdirSync(dokploy).filter((f) => f.endsWith('.yml'));
    expect(composes.length).toBeGreaterThan(0);
    for (const archivo of composes) {
      const texto = readFileSync(join(dokploy, archivo), 'utf8');
      expect(texto, `${archivo} declara IAXTI_LOGIN_DEV`).not.toContain('IAXTI_LOGIN_DEV');
      expect(texto, `${archivo} declara el servicio auth-local`).not.toContain('auth-local');
    }
  });

  it('el Dockerfile no copia infra/: el servidor firmador no tiene imagen posible', () => {
    const dockerfile = readFileSync(join(RAIZ, 'infra', 'docker', 'Dockerfile'), 'utf8');
    const copias = dockerfile.split('\n').filter((l) => l.trim().startsWith('COPY'));
    expect(copias.length).toBeGreaterThan(0);
    for (const linea of copias) {
      // infra/docker (entrypoint.sh) es legítimo: lo prohibido es el
      // firmador, o arrastrar infra/ entero.
      expect(linea, 'el Dockerfile copia el firmador local').not.toMatch(
        /COPY\s+(--from=\S+\s+)?(\.\/)?infra\/auth-local/,
      );
      expect(linea, 'el Dockerfile copia infra/ entero').not.toMatch(
        /COPY\s+(--from=\S+\s+)?(\.\/)?infra\/?\s/,
      );
      expect(linea, 'el Dockerfile copia el contexto entero').not.toMatch(/COPY\s+\.\s+/);
    }
  });

  it('la página exige el flag exacto Y que el ambiente no sea staging/producción', () => {
    // Guarda de fuente sobre la doble cerradura: la de comportamiento vive en
    // apps/web/tests/entrar-local-cerrado.test.tsx; esta muerde si alguien
    // «simplifica» una de las dos condiciones.
    const pagina = readFileSync(join(RAIZ, 'apps', 'web', 'app', 'entrar-local', 'page.tsx'), 'utf8');
    expect(pagina).toContain("process.env.IAXTI_LOGIN_DEV !== '1'");
    expect(pagina).toContain("ambiente === 'production' || ambiente === 'staging'");
    expect(pagina.match(/notFound\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('el server firmador se niega a arrancar en staging/producción', () => {
    const server = readFileSync(join(RAIZ, 'infra', 'auth-local', 'server.mjs'), 'utf8');
    expect(server).toContain("AMBIENTE === 'production' || AMBIENTE === 'staging'");
    expect(server).toContain('process.exit(1)');
    // Y solo firma identidades del seed de demostración.
    expect(server).toContain("@demo-iaxti.cl");
  });
});
