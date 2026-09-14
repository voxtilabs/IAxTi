import { findModulesDir, loadAllManifests, type ModuleManifest } from './manifest';

/** Núcleo que nunca se apaga (SPEC §26 regla 8). */
export const CORE_MODULES = ['identity', 'organizations', 'authorization', 'audit'] as const;

export interface ModuleHealth {
  id: string;
  version: string;
  core: boolean;
  active: boolean;
  killSwitch: boolean;
  dependsOn: string[];
}

interface PlatformState {
  enabled: boolean;
  killSwitch: boolean;
}

/**
 * Module Registry (SPEC §26): lee los manifiestos, construye el grafo,
 * valida ciclos y colisiones de permisos y eventos, y expone el orden
 * topológico de inicialización. Toda validación fallida ABORTA el arranque:
 * lanzar aquí es el comportamiento correcto.
 */
export class ModuleRegistry {
  private manifests = new Map<string, ModuleManifest>();
  private order: string[] = [];
  private state = new Map<string, PlatformState>();
  private contracts = new Map<string, unknown>();

  constructor(private readonly modulesDir = findModulesDir()) {}

  load(): this {
    const all = loadAllManifests(this.modulesDir);

    for (const manifest of all) {
      const id = manifest.module.id;
      if (this.manifests.has(id)) throw new Error(`Módulo duplicado: "${id}"`);
      this.manifests.set(id, manifest);
    }

    this.validateDependencies();
    this.validateCollisions();
    this.order = this.topologicalOrder();

    for (const id of this.order) {
      this.state.set(id, { enabled: true, killSwitch: false });
    }
    return this;
  }

  private validateDependencies(): void {
    for (const [id, manifest] of this.manifests) {
      for (const dep of manifest.depends_on?.required ?? []) {
        if (!this.manifests.has(dep)) {
          throw new Error(`El módulo "${id}" requiere "${dep}", que no existe`);
        }
      }
      const isCore = manifest.module.core === true;
      const shouldBeCore = (CORE_MODULES as readonly string[]).includes(id);
      if (isCore !== shouldBeCore) {
        throw new Error(
          `El módulo "${id}" declara core: ${isCore}, pero el núcleo es exactamente ${CORE_MODULES.join(', ')}`,
        );
      }
    }
  }

  private validateCollisions(): void {
    const permissionOwner = new Map<string, string>();
    const eventPublisher = new Map<string, string>();

    for (const [id, manifest] of this.manifests) {
      for (const permission of manifest.permissions ?? []) {
        const owner = permissionOwner.get(permission);
        if (owner) {
          throw new Error(`Colisión de permiso "${permission}" entre "${owner}" y "${id}"`);
        }
        permissionOwner.set(permission, id);
      }
      for (const event of manifest.events?.publishes ?? []) {
        const publisher = eventPublisher.get(event);
        if (publisher) {
          throw new Error(`Colisión de evento "${event}": lo publican "${publisher}" y "${id}"`);
        }
        eventPublisher.set(event, id);
      }
    }
  }

  private topologicalOrder(): string[] {
    const inDegree = new Map<string, number>();
    for (const [id, manifest] of this.manifests) {
      inDegree.set(id, (manifest.depends_on?.required ?? []).length);
    }

    const queue = [...inDegree.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      order.push(id);
      for (const [candidate, manifest] of this.manifests) {
        if ((manifest.depends_on?.required ?? []).includes(id)) {
          const remaining = (inDegree.get(candidate) ?? 0) - 1;
          inDegree.set(candidate, remaining);
          if (remaining === 0) {
            queue.push(candidate);
            queue.sort();
          }
        }
      }
    }

    if (order.length !== this.manifests.size) {
      const pending = [...this.manifests.keys()].filter((id) => !order.includes(id));
      throw new Error(`Ciclo de dependencias entre módulos: ${pending.join(', ')}`);
    }
    return order;
  }

  /** Orden de inicialización (dependencias primero). */
  initOrder(): string[] {
    return [...this.order];
  }

  manifest(id: string): ModuleManifest {
    const manifest = this.manifests.get(id);
    if (!manifest) throw new Error(`Módulo desconocido: "${id}"`);
    return manifest;
  }

  /** Activo a nivel plataforma: habilitado y sin kill-switch. */
  isActive(id: string): boolean {
    const state = this.state.get(id);
    return state !== undefined && state.enabled && !state.killSwitch;
  }

  /** Regla 4: no se apaga un módulo del que otro activo depende como required. */
  disable(id: string): void {
    if ((CORE_MODULES as readonly string[]).includes(id)) {
      throw new Error(`"${id}" es núcleo y no se puede apagar`);
    }
    const dependents = [...this.manifests.values()]
      .filter(
        (m) =>
          this.isActive(m.module.id) &&
          (m.depends_on?.required ?? []).includes(id),
      )
      .map((m) => m.module.id);
    if (dependents.length > 0) {
      throw new Error(
        `No se puede apagar "${id}": lo requieren módulos activos (${dependents.join(', ')}). Apaga primero esos.`,
      );
    }
    const state = this.state.get(id);
    if (state) state.enabled = false;
  }

  enable(id: string): void {
    const manifest = this.manifest(id);
    const missing = (manifest.depends_on?.required ?? []).filter((dep) => !this.isActive(dep));
    if (missing.length > 0) {
      throw new Error(`No se puede activar "${id}": requiere ${missing.join(', ')} activos`);
    }
    const state = this.state.get(id);
    if (state) state.enabled = true;
  }

  killSwitch(id: string, on: boolean): void {
    if (on && (CORE_MODULES as readonly string[]).includes(id)) {
      throw new Error(`"${id}" es núcleo y no tiene kill-switch`);
    }
    const state = this.state.get(id);
    if (state) state.killSwitch = on;
  }

  /** GET /health/modules (SPEC §26 regla 2). */
  health(): ModuleHealth[] {
    return this.order.map((id) => {
      const manifest = this.manifests.get(id) as ModuleManifest;
      const state = this.state.get(id) as PlatformState;
      return {
        id,
        version: manifest.module.version,
        core: manifest.module.core === true,
        active: this.isActive(id),
        killSwitch: state.killSwitch,
        dependsOn: manifest.depends_on?.required ?? [],
      };
    });
  }

  /** Catálogo de permisos generado desde los manifiestos (SPEC §27). */
  /** Todos los eventos publicables por módulos ACTIVOS (#76): el catálogo
   *  al que un tenant puede suscribir sus webhooks. */
  eventsCatalog(): string[] {
    const eventos: string[] = [];
    for (const [id, manifest] of this.manifests) {
      if (!this.isActive(id)) continue;
      eventos.push(...(manifest.events?.publishes ?? []));
    }
    return eventos.sort();
  }

  permissionsCatalog(): Map<string, string> {
    const catalog = new Map<string, string>();
    for (const [id, manifest] of this.manifests) {
      for (const permission of manifest.permissions ?? []) catalog.set(permission, id);
    }
    return catalog;
  }

  /** Un módulo registra su contrato al inicializar. */
  registerContract(id: string, contract: unknown): void {
    this.manifest(id);
    this.contracts.set(id, contract);
  }

  /**
   * Dependencias opcionales (SPEC §26 regla 7): null degrada, no rompe.
   * Devuelve el contrato solo si el módulo existe, está activo y lo registró.
   */
  capability<T>(id: string): T | null {
    if (!this.manifests.has(id) || !this.isActive(id)) return null;
    return (this.contracts.get(id) as T | undefined) ?? null;
  }
}
