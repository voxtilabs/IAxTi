import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parcheHealthchecks } from '../../../scripts/sincronizar-healthchecks.mjs';

const canonicalPath = fileURLToPath(new URL('../../../infra/dokploy/docker-compose.staging.yml', import.meta.url));
const canonical = readFileSync(canonicalPath, 'utf8');
const raw = `# Configuración del operador
x-app: &app
  image: imagen-personalizada
services:
  web:
    <<: *app
    healthcheck: &hc
      test: [CMD, node, -e, 'process.exit(0)']
    labels: {traefik.enable: 'true'}
  admin:
    <<: *app
    healthcheck: *hc
  workers:
    <<: *app
    environment: {DATABASE_URL: credencial-privada-de-prueba}
    networks: [interna]
  agents:
    <<: *app
    volumes: ['datos:/datos']
networks: {interna: {external: true}}
volumes: {datos: {}}
`;
const decode = text => parse(text, { merge: true });

describe('healthchecks de Dokploy raw (#396)', () => {
  it('agrega solo los dos checks ausentes y conserva redes, labels, variables, volúmenes y anchors', () => {
    const patch = parcheHealthchecks({ sourceType: 'raw', composeFile: raw }, canonical);
    const updated = decode(patch.composeFile);
    const expected = decode(canonical);
    for (const service of ['workers', 'agents']) {
      expect(updated.services[service].healthcheck).toEqual(expected.services[service].healthcheck);
      delete updated.services[service].healthcheck;
    }
    // Y desde #573 también se completa IAXTI_IMAGE. Se quita para que esta prueba
    // siga afirmando lo suyo: que NADA MÁS cambia.
    for (const service of Object.keys(updated.services)) {
      expect(updated.services[service].environment.IAXTI_IMAGE, service).toBe('${IMAGE}');
      delete updated.services[service].environment.IAXTI_IMAGE;
      // El servicio que no tenía `environment` queda con un mapa vacío; el que
      // tenía conserva lo suyo, que es lo que comprueba la comparación de abajo.
      if (Object.keys(updated.services[service].environment).length === 0) {
        delete updated.services[service].environment;
      }
    }
    expect(updated).toEqual(decode(raw));
    expect(patch.composeFile).toContain('# Configuración del operador');
    expect(patch.composeFile).toContain('&hc');
    expect(patch.composeFile).toContain('*hc');
    expect(Object.keys(patch)).toEqual(['composeFile']);
  });

  it('es idempotente y no devuelve configuración cuando no hay cambios', () => {
    const first = parcheHealthchecks({ sourceType: 'raw', composeFile: raw }, canonical);
    expect(parcheHealthchecks({ sourceType: 'raw', ...first }, canonical)).toEqual({});
  });

  it('respeta un check existente personalizado y completa el otro', () => {
    const custom = raw.replace('  workers:\n', '  workers:\n    healthcheck: {test: [CMD, personalizado], interval: 1m}\n');
    const result = decode(parcheHealthchecks({ sourceType: 'raw', composeFile: custom }, canonical).composeFile);
    expect(result.services.workers.healthcheck).toEqual(decode(custom).services.workers.healthcheck);
    expect(result.services.agents.healthcheck).toEqual(decode(canonical).services.agents.healthcheck);
  });

  it('no crea un servicio que falta', () => {
    expect(() => parcheHealthchecks({ sourceType: 'raw', composeFile: 'services: {workers: {}}' }, canonical)).toThrow('No se pudieron validar');
  });

  it('rechaza una fuente canónica sin checks', () => {
    expect(() => parcheHealthchecks({ sourceType: 'raw', composeFile: raw }, 'services: {}')).toThrow('No se pudieron validar');
  });

  it('un error YAML no expone líneas de configuración', () => {
    expect(() => parcheHealthchecks({ sourceType: 'raw', composeFile: '[credencial-privada-de-prueba' }, canonical))
      .toThrow('No se pudieron validar los healthchecks de Compose; no se aplicó el parche.');
  });

  it('no reactiva por sorpresa un check deshabilitado por el operador', () => {
    const disabled = raw.replace('  workers:\n', '  workers:\n    healthcheck: {disable: true}\n');
    expect(() => parcheHealthchecks({ sourceType: 'raw', composeFile: disabled }, canonical)).toThrow('No se pudieron validar');
  });

  it('las fuentes Git conservan su archivo y un origen desconocido falla', () => {
    for (const sourceType of ['git', 'github', 'gitlab', 'bitbucket', 'gitea']) {
      expect(parcheHealthchecks({ sourceType }, canonical)).toEqual({});
    }
    expect(() => parcheHealthchecks({}, canonical)).toThrow('Origen de Compose desconocido.');
  });

  it('la CLI falla sin imprimir la entrada ni preparar una mutación', () => {
    const script = fileURLToPath(new URL('../../../scripts/sincronizar-healthchecks.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, canonicalPath], { input: '{credencial-privada-de-prueba', encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('credencial-privada-de-prueba');
    expect(result.stderr).toContain('la configuración no se modificó');
  });
});

/**
 * La ventana sin atender de cada despliegue (#254).
 *
 * Entre que Dokploy dice `done` y el primer 200 pasan minutos, y durante
 * ese rato el proxy contesta 404 porque no tiene a quién mandarle. Parte
 * de eso es que el contenedor se marca `unhealthy` antes de haber tenido
 * la oportunidad de arrancar: sin `start_period`, Docker cuenta los
 * fallos desde el segundo cero, y el proxy no le manda tráfico a un
 * contenedor unhealthy.
 */
describe('los healthchecks le dan tiempo a arrancar (#254)', () => {
  const composes = ['staging', 'prod'].map(nombre => [
    nombre,
    decode(readFileSync(fileURLToPath(new URL(`../../../infra/dokploy/docker-compose.${nombre}.yml`, import.meta.url)), 'utf8')),
  ]);

  it('todos los servicios de la aplicación declaran start_period', () => {
    for (const [nombre, compose] of composes) {
      for (const [servicio, definicion] of Object.entries(compose.services)) {
        if (!definicion.healthcheck) continue;
        expect(definicion.healthcheck.start_period, `${nombre}/${servicio}`).toBeTruthy();
      }
    }
  });

  it('el margen cubre de sobra el arranque más lento que se ha visto', () => {
    // `retries × interval` es lo que el contenedor aguanta DESPUÉS del
    // margen. Si el margen fuera más corto que un arranque normal, esto no
    // serviría de nada.
    for (const [nombre, compose] of composes) {
      for (const [servicio, definicion] of Object.entries(compose.services)) {
        const margen = definicion.healthcheck?.start_period;
        if (!margen) continue;
        expect(Number(String(margen).replace('s', '')), `${nombre}/${servicio}`).toBeGreaterThanOrEqual(30);
      }
    }
  });
});

/**
 * La versión de la imagen llega al contenedor (#573).
 *
 * `IAXTI_IMAGE` estaba declarado en el compose del repo desde #392 y NUNCA llegaba:
 * el compose de Dokploy es raw, y este script solo sincronizaba healthchecks. El
 * síntoma visible fue `/health` devolviendo `sha: null`; el invisible, y peor, que
 * el `release` de Sentry venía vacío — que era todo el motivo de esa variable.
 */
describe('la versión de la imagen llega al contenedor (#573)', () => {
  const sinVersion = `x-app: &app
  image: \${IMAGE}
services:
  api:
    <<: *app
    environment: {DATABASE_URL: credencial-privada-de-prueba}
  workers:
    <<: *app
  agents:
    <<: *app
  web:
    <<: *app
  admin:
    <<: *app
`;

  it('completa IAXTI_IMAGE en los cinco servicios y no toca lo del operador', () => {
    const patch = parcheHealthchecks({ sourceType: 'raw', composeFile: sinVersion }, canonical);
    const updated = decode(patch.composeFile);
    for (const service of ['api', 'workers', 'agents', 'web', 'admin']) {
      expect(updated.services[service].environment.IAXTI_IMAGE, service).toBe('${IMAGE}');
    }
    // Lo que el operador tenía sigue igual, con su valor y no con el del repo.
    expect(updated.services.api.environment.DATABASE_URL).toBe('credencial-privada-de-prueba');
  });

  it('no pisa un IAXTI_IMAGE que el operador ya puso', () => {
    // Este parche completa, no manda: si alguien lo fijó a mano tendrá un motivo,
    // y sobrescribirlo desde el deploy es la forma de perder una hora buscando.
    const conSuyo = sinVersion.replace(
      'environment: {DATABASE_URL: credencial-privada-de-prueba}',
      'environment: {DATABASE_URL: privada, IAXTI_IMAGE: mia}',
    );
    const patch = parcheHealthchecks({ sourceType: 'raw', composeFile: conSuyo }, canonical);
    const updated = decode(patch.composeFile);
    expect(updated.services.api.environment.IAXTI_IMAGE).toBe('mia');
  });

  it('NO completa las claves donde la cadena vacía haría daño', () => {
    // Esta es la decisión de #573, y la guarda existe para que no se relaje sin
    // pensarlo. Si la variable del proyecto no está puesta, Compose sustituye
    // cadena vacía, y `??` no la atrapa: la clave pasaría de `undefined` —que cae
    // a su por-defecto— a `''`, que no cae.
    //
    //   IAXTI_ENV           `?? 'development'` en rls.ts (aislamiento por tenant)
    //   AUDIT_EXPORT_SECRET `?? null` al firmar la exportación de auditoría
    //   PUBLIC_API_URL      `?? 'https://api-staging…'` en los LINKS DE PAGO
    //
    // Generalizar esto antes de arreglar esa familia sería cambiar un fallo
    // visible por tres invisibles, dos de ellos en plata y auditoría.
    const patch = parcheHealthchecks({ sourceType: 'raw', composeFile: sinVersion }, canonical);
    const updated = decode(patch.composeFile);
    for (const clave of ['IAXTI_ENV', 'AUDIT_EXPORT_SECRET', 'PUBLIC_API_URL', 'DATABASE_URL']) {
      expect(updated.services.workers.environment[clave], clave).toBeUndefined();
    }
  });

  it('es idempotente: aplicado dos veces no cambia nada', () => {
    const primero = parcheHealthchecks({ sourceType: 'raw', composeFile: sinVersion }, canonical);
    const segundo = parcheHealthchecks(
      { sourceType: 'raw', composeFile: primero.composeFile },
      canonical,
    );
    expect(segundo).toEqual({});
  });

  it('con environment en forma de lista no se mezcla nada', () => {
    // `- CLAVE=valor` es otra forma válida de Compose, y mezclarla con la de mapa
    // a mano es cómo se rompen las dos. Se prefiere no tocar y decirlo.
    const enLista = sinVersion.replace(
      'environment: {DATABASE_URL: credencial-privada-de-prueba}',
      'environment: [DATABASE_URL=privada]',
    );
    expect(() => parcheHealthchecks({ sourceType: 'raw', composeFile: enLista }, canonical)).toThrow(
      /no se pudieron validar/i,
    );
  });
});
