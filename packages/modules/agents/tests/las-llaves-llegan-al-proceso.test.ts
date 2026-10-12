import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS } from '../domain/config';
import { ENV_KEYS } from '../application/models';

/**
 * La llave de cada proveedor LLEGA al proceso en local (#844).
 *
 * `docker-compose.yml` pasaba a los cinco servicios exactamente dos variables:
 * `DATABASE_URL` y `REDIS_URL`. Ninguna llave de proveedor. Así que una llave
 * puesta en el `.env` de la raíz no llegaba a ningún contenedor,
 * `providerAvailable()` daba false para los cuatro, y la IA contestaba «no hay
 * proveedor con credencial» **con la llave puesta en el archivo**.
 *
 * Es la forma de siempre —declarado en un lado, aplicado en ninguno— y acá lo
 * declarado era el `.env`: el archivo donde uno pone las llaves, leído por
 * nadie.
 *
 * Los dos compose del despliegue sí las pasan, y eso lo cuida
 * `variables-del-despliegue.test.ts`. El local no lo cuidaba nadie, que es
 * justo el que usa quien quiere probar.
 */
const RAIZ = join(__dirname, '..', '..', '..', '..');
const COMPOSE_LOCAL = join(RAIZ, 'docker-compose.yml');

describe('las llaves de los proveedores llegan al proceso', () => {
  const compose = readFileSync(COMPOSE_LOCAL, 'utf8');

  it('la guarda está mirando algo: hay proveedores y hay compose', () => {
    // Anti-vacuidad: con `PROVIDERS` vacío el `for` de abajo no correría.
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(3);
    expect(compose).toContain('environment: &app-env');
  });

  it('el compose local pasa la variable de cada proveedor', () => {
    const faltan = PROVIDERS.filter((p) => !compose.includes(`${ENV_KEYS[p]}:`));
    expect(
      faltan.map((p) => `${p} → ${ENV_KEYS[p]}`),
      'Estos proveedores son elegibles y su llave NO llega a los contenedores locales: ' +
        'quien la ponga en `.env` va a ver «no hay proveedor con credencial» con la llave ' +
        `puesta.\n  ${faltan.map((p) => ENV_KEYS[p]).join('\n  ')}`,
    ).toEqual([]);
  });

  it('las pasa por REFERENCIA, nunca con el valor escrito', () => {
    // Un secreto en el compose es un secreto en Git.
    for (const p of PROVIDERS) {
      const linea = new RegExp(`^\\s*${ENV_KEYS[p]}:\\s*(.+)$`, 'm').exec(compose);
      expect(linea, `${ENV_KEYS[p]} no está en el compose local`).toBeTruthy();
      expect(
        linea![1].trim(),
        `${ENV_KEYS[p]} tiene un valor escrito en el compose en vez de una referencia`,
      ).toMatch(/^\$\{/);
    }
  });

  /**
   * Y que la llave tenga camino hasta STAGING (#848).
   *
   * El deploy siembra las llaves en el env de Dokploy desde secretos de
   * GitHub, «así ningún humano las pega en el panel». Estaba escrito a mano
   * para GLM nada más, así que agregar un proveedor dejaba su llave sin
   * camino: había que editar el workflow o pegarla en el panel, que es justo
   * lo que ese bloque evita.
   *
   * Lo que faltaba no era la línea de OpenAI: era que fuera una lista.
   */
  it('el deploy de staging siembra la llave de cada proveedor', () => {
    const workflow = readFileSync(
      join(RAIZ, '.github', 'workflows', 'deploy-staging.yml'),
      'utf8',
    );
    // La lista de llaves es el argumento del script que siembra (#860): el
    // bloque salió del YAML para poder probarse, pero QUÉ se siembra sigue
    // decidiéndose acá, y es lo que esta guarda cuida.
    const lista = /sembrar-llaves\.sh\s*\\?\s*\n?\s*([A-Z_\s]+?)\)/.exec(workflow);
    expect(lista, 'no se encontró la lista de llaves a sembrar en el deploy').toBeTruthy();
    const sembradas = lista![1].trim().split(/\s+/);
    // Anti-vacuidad: si el recorte fallara, el filtro de abajo no mediría nada.
    expect(sembradas.length).toBeGreaterThanOrEqual(3);

    const faltan = PROVIDERS.filter((p) => !sembradas.includes(ENV_KEYS[p]));
    expect(
      faltan.map((p) => `${p} → ${ENV_KEYS[p]}`),
      'Estas llaves no tienen camino hasta staging: el deploy no las siembra, así que habría ' +
        'que pegarlas a mano en el panel de Dokploy — que es lo que ese bloque existe para ' +
        `evitar.\n  ${faltan.map((p) => ENV_KEYS[p]).join('\n  ')}`,
    ).toEqual([]);

    // Y que cada una venga de un secreto, no escrita en el workflow.
    for (const p of PROVIDERS) {
      const linea = new RegExp(`^\\s*${ENV_KEYS[p]}: \\$\\{\\{ secrets\\.`, 'm');
      expect(workflow, `${ENV_KEYS[p]} no viene de un secreto en el deploy`).toMatch(linea);
    }
  });

  /**
   * Y que la llave llegue al CONTENEDOR de staging (#853).
   *
   * El Compose raw de Dokploy no relee el YAML del repo sin detener el stack,
   * así que el deploy completa las claves ausentes con
   * `sincronizar-healthchecks.mjs` — y esa lista es corta a propósito (#573):
   * completar una clave que hoy llega `undefined` y cae a su por-defecto por
   * `??` la convertiría en `''`, que `??` no atrapa.
   *
   * Las llaves de proveedor pasan esa prueba —`providerAvailable` hace
   * `Boolean(process.env[...])`, y `''` es falso igual que `undefined`— pero
   * solo `ANTHROPIC_API_KEY` estaba en la lista. `GLM_API_KEY`, el proveedor
   * por defecto de ocho de las nueve tareas, no: estaba en el compose del repo
   * y no llegaba al contenedor. El diagnóstico de la IA en staging lo decía con
   * todas las letras —«1 de 4 con credencial: google», «8 de 9 no pueden
   * funcionar»— con el secreto puesto y el valor en el env de Dokploy.
   */
  it('el deploy completa la llave de cada proveedor en el Compose raw', () => {
    const script = readFileSync(
      join(RAIZ, 'scripts', 'sincronizar-healthchecks.mjs'),
      'utf8',
    );
    const lista = /CLAVES_QUE_SE_COMPLETAN = new Set\(\[([\s\S]*?)\]\)/.exec(script);
    expect(lista, 'no se encontró CLAVES_QUE_SE_COMPLETAN en el sincronizador').toBeTruthy();
    const claves = [...lista![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    // Anti-vacuidad: si el recorte fallara, el filtro de abajo no mediría nada.
    expect(claves.length).toBeGreaterThanOrEqual(3);

    const faltan = PROVIDERS.filter((p) => !claves.includes(ENV_KEYS[p]));
    expect(
      faltan.map((p) => `${p} → ${ENV_KEYS[p]}`),
      'Estas llaves están en el compose del repo y NO se completan en el Compose raw de ' +
        'Dokploy, que es el que se despliega: el contenedor no las va a ver nunca, tenga el ' +
        `secreto o no.\n  ${faltan.map((p) => ENV_KEYS[p]).join('\n  ')}`,
    ).toEqual([]);
  });

  it('y los procesos que no son Next cargan el .env si está', () => {
    /**
     * La otra mitad del mismo defecto. `apps/api`, `apps/workers` y
     * `apps/agents` arrancan con `node dist/main.js` y **nada** cargaba el
     * `.env`: solo `apps/web` lo lee, porque Next lo hace solo. O sea que ni
     * siquiera corriendo fuera de Docker las llaves llegaban.
     *
     * `--env-file-if-exists` y no `--env-file`: en la imagen de producción no
     * hay `.env` y `--env-file` revienta si falta. Y el entorno real GANA
     * sobre el archivo —comprobado—, así que en producción esto no cambia nada.
     */
    for (const app of ['api', 'workers', 'agents']) {
      const pkg = JSON.parse(
        readFileSync(join(RAIZ, 'apps', app, 'package.json'), 'utf8'),
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts.start, `apps/${app} no carga el .env al arrancar`).toContain(
        '--env-file-if-exists',
      );
      // Y que no sea el que revienta cuando el archivo no está.
      expect(pkg.scripts.start).not.toMatch(/--env-file=/);
    }
  });
});
