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
