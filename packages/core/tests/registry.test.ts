import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModuleRegistry } from '../src/registry';

/**
 * Los directorios temporales se borran al terminar.
 *
 * Sin esto cada corrida deja uno —esta prueba, varios— y el tmpfs se llena: llegué
 * a 2168 directorios `iaxti-*` y más de 600 MB, y lo que rompió no fue una prueba
 * sino la máquina, a mitad de otra cosa. Una prueba que deja basura es una prueba
 * que a la larga hace fallar a las demás, y el fallo aparece lejísimos de acá.
 */
const temporales: string[] = [];
function registrarTemporal(dir: string): string {
  temporales.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});


/** Crea un directorio de módulos de fixture con los manifiestos dados. */
function fixture(mods: Record<string, string>): string {
  const dir = registrarTemporal(mkdtempSync(join(tmpdir(), 'iaxti-registry-')));
  for (const [id, yaml] of Object.entries(mods)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'module.yaml'), yaml);
  }
  return dir;
}

const nucleo = {
  identity: `module: { id: identity, version: 0.1.0, core: true }\npermissions: [users.read]\n`,
  organizations: `module: { id: organizations, version: 0.1.0, core: true }\ndepends_on: { required: [identity] }\npermissions: [tenant.read]\n`,
  authorization: `module: { id: authorization, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\npermissions: [roles.read]\n`,
  audit: `module: { id: audit, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\npermissions: [audit.read]\n`,
};

describe('ModuleRegistry', () => {
  it('carga los manifiestos reales del repo en orden topológico', () => {
    const registry = new ModuleRegistry(resolve(__dirname, '../../modules')).load();
    const order = registry.initOrder();
    expect(order.indexOf('identity')).toBeLessThan(order.indexOf('organizations'));
    expect(order.indexOf('organizations')).toBeLessThan(order.indexOf('authorization'));
    expect(registry.health().every((m) => m.active)).toBe(true);
  });

  it('un ciclo de dependencias aborta el arranque', () => {
    const dir = fixture({
      ...nucleo,
      alfa: `module: { id: alfa, version: 0.1.0 }\ndepends_on: { required: [beta] }\n`,
      beta: `module: { id: beta, version: 0.1.0 }\ndepends_on: { required: [alfa] }\n`,
    });
    expect(() => new ModuleRegistry(dir).load()).toThrow(/Ciclo de dependencias/);
  });

  it('una colisión de permisos aborta el arranque', () => {
    const dir = fixture({
      ...nucleo,
      crm: `module: { id: crm, version: 0.1.0 }\npermissions: [users.read]\n`,
    });
    expect(() => new ModuleRegistry(dir).load()).toThrow(/Colisión de permiso "users.read"/);
  });

  it('una colisión de eventos publicados aborta el arranque', () => {
    const dir = fixture({
      ...nucleo,
      crm: `module: { id: crm, version: 0.1.0 }\nevents: { publishes: [cosa.paso] }\n`,
      ventas: `module: { id: ventas, version: 0.1.0 }\nevents: { publishes: [cosa.paso] }\n`,
    });
    expect(() => new ModuleRegistry(dir).load()).toThrow(/Colisión de evento "cosa.paso"/);
  });

  it('una dependencia requerida inexistente aborta el arranque', () => {
    const dir = fixture({
      ...nucleo,
      crm: `module: { id: crm, version: 0.1.0 }\ndepends_on: { required: [fantasma] }\n`,
    });
    expect(() => new ModuleRegistry(dir).load()).toThrow(/requiere "fantasma"/);
  });

  it('no se apaga un módulo con dependientes activos, y dice cuáles', () => {
    const dir = fixture({
      ...nucleo,
      crm: `module: { id: crm, version: 0.1.0 }\ndepends_on: { required: [identity] }\n`,
      conversations: `module: { id: conversations, version: 0.1.0 }\ndepends_on: { required: [crm] }\n`,
    });
    const registry = new ModuleRegistry(dir).load();
    expect(() => registry.disable('crm')).toThrow(/lo requieren módulos activos \(conversations\)/);
    registry.disable('conversations');
    registry.disable('crm');
    expect(registry.isActive('crm')).toBe(false);
  });

  it('el núcleo no se apaga ni tiene kill-switch', () => {
    const dir = fixture(nucleo);
    const registry = new ModuleRegistry(dir).load();
    expect(() => registry.disable('identity')).toThrow(/núcleo/);
    expect(() => registry.killSwitch('audit', true)).toThrow(/núcleo/);
  });

  it('capability devuelve null para módulo apagado o sin contrato (degradar, no romper)', () => {
    const dir = fixture({
      ...nucleo,
      calendar: `module: { id: calendar, version: 0.1.0 }\n`,
    });
    const registry = new ModuleRegistry(dir).load();
    expect(registry.capability('calendar')).toBeNull();
    registry.registerContract('calendar', { agendar: true });
    expect(registry.capability('calendar')).toEqual({ agendar: true });
    registry.disable('calendar');
    expect(registry.capability('calendar')).toBeNull();
    expect(registry.capability('inexistente')).toBeNull();
  });

  it('un módulo fuera del núcleo no puede declararse core', () => {
    const dir = fixture({
      ...nucleo,
      crm: `module: { id: crm, version: 0.1.0, core: true }\n`,
    });
    expect(() => new ModuleRegistry(dir).load()).toThrow(/núcleo es exactamente/);
  });
});
