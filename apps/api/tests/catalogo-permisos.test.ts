import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El catálogo de permisos no puede juntar polvo.
 *
 * Un permiso declarado y no verificado en ninguna parte es un permiso que
 * alguien le da a un rol creyendo que hace algo. Así estaban `users.invite`,
 * `users.read` y `users.manage`: declarados, dados al ADMIN, y sin una sola
 * ruta que los exigiera — no existía forma de invitar a nadie.
 *
 * Lo contrario es peor: una ruta que exige un permiso inexistente responde
 * 403 para siempre, incluso al dueño del negocio.
 */
const REPO = join(__dirname, '../../..');
const MODULOS = join(REPO, 'packages/modules');

function archivosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === 'dist') continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivosTs(ruta));
    else if (ruta.endsWith('.ts')) salida.push(ruta);
  }
  return salida;
}

function declarados(): Set<string> {
  const todos = new Set<string>();
  for (const modulo of readdirSync(MODULOS)) {
    const manifiesto = join(MODULOS, modulo, 'module.yaml');
    let crudo: string;
    try {
      crudo = readFileSync(manifiesto, 'utf8');
    } catch {
      continue; // Un módulo sin manifiesto lo caza el registry, no este test.
    }
    // El bloque `permissions:` es una lista plana hasta la siguiente clave.
    const bloque = crudo.split(/^permissions:$/m)[1]?.split(/^[a-z_]+:/m)[0] ?? '';
    for (const m of bloque.matchAll(/^ {2}- ([a-z0-9._]+)$/gm)) todos.add(m[1]);
  }
  return todos;
}

/** Cualquier mención del permiso en el código: ruta, `actorCan`, tool. */
function verificados(): Set<string> {
  const usados = new Set<string>();
  const fuentes = [
    ...archivosTs(join(REPO, 'apps/api/src')),
    ...archivosTs(join(REPO, 'apps/workers/src')),
    ...archivosTs(MODULOS).filter((f) => !f.includes('/tests/')),
  ];
  for (const archivo of fuentes) {
    const contenido = readFileSync(archivo, 'utf8');
    for (const m of contenido.matchAll(/'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g)) {
      usados.add(m[1]);
    }
  }
  // Los manifiestos también los usan: nav y tools declaran permisos.
  for (const modulo of readdirSync(MODULOS)) {
    try {
      const crudo = readFileSync(join(MODULOS, modulo, 'module.yaml'), 'utf8');
      for (const m of crudo.matchAll(/permission: *([a-z0-9._]+)/g)) usados.add(m[1]);
      for (const m of crudo.matchAll(/^ {2}- ([a-z0-9._]+)$/gm)) {
        // Las tools se declaran igual que los permisos; se cuentan aparte.
        if (crudo.slice(0, m.index).includes('tools:')) usados.add(m[1]);
      }
    } catch {
      // ya cubierto arriba
    }
  }
  return usados;
}

/**
 * Permisos que existen para una función TODAVÍA no construida. Cada uno con
 * su motivo y su issue: la lista distingue "falta hacerlo" de "se nos
 * olvidó", que es justo lo que no se podía distinguir.
 */
const PENDIENTES: Record<string, string> = {
  // Nota: las TOOLS de los agentes (`crm.find_contact`, `conversations.send_reply`…)
  // se declaran en el bloque `tools:` del manifiesto y no son permisos —
  // el registry las filtra por módulo activo. No van acá.
  'calendar.connect':
    'Conectar Google Calendar: necesita las credenciales de OAuth (#57). La agenda funciona sin él, con la disponibilidad configurada.',
  'tenant.billing': 'Ver y cambiar el plan desde la app; hoy lo hace el SuperAdmin (#69).',
  'whatsapp.numbers.manage':
    'Administrar números desde la app; hoy la conexión es por script (#42) y el resto usa channels.manage.',
  'crm.contacts.update': 'Cubierto por crm.contacts.create en el controlador; falta separar la edición.',
  'crm.deals.close': 'Cerrar una oportunidad usa crm.deals.update; falta separar el cierre.',
};

describe('catálogo de permisos', () => {
  it('ninguna ruta exige un permiso que no exista', () => {
    const declarada = declarados();
    const enRutas = new Set<string>();
    for (const archivo of archivosTs(join(REPO, 'apps/api/src'))) {
      for (const m of readFileSync(archivo, 'utf8').matchAll(/@RequirePermission\('([^']+)'\)/g)) {
        enRutas.add(m[1]);
      }
    }
    expect(enRutas.size).toBeGreaterThan(30);
    const inventados = [...enRutas].filter((p) => !declarada.has(p));
    expect(
      inventados,
      `Estas rutas exigen permisos que no están en ningún module.yaml:\n  ${inventados.join('\n  ')}\n` +
        'Responderían 403 para siempre, incluso al dueño del negocio.',
    ).toEqual([]);
  });

  it('todo permiso declarado se verifica en alguna parte, o está en la lista de pendientes', () => {
    const declarada = declarados();
    const usada = verificados();
    expect(declarada.size).toBeGreaterThan(50);

    const huerfanos = [...declarada]
      .filter((p) => !usada.has(p))
      .filter((p) => !(p in PENDIENTES))
      .sort();

    expect(
      huerfanos,
      `Estos permisos existen en el catálogo y NADIE los verifica:\n  ${huerfanos.join('\n  ')}\n` +
        'Alguien se los va a dar a un rol creyendo que hacen algo. Úsalos, bórralos, ' +
        'o agrégalos a PENDIENTES con el motivo y el issue.',
    ).toEqual([]);
  });

  it('la lista de pendientes no menciona permisos que ya no existen', () => {
    const declarada = declarados();
    const fantasmas = Object.keys(PENDIENTES).filter((p) => !declarada.has(p));
    expect(fantasmas, `Pendientes que ya no están en ningún catálogo: ${fantasmas.join(', ')}`).toEqual([]);
  });
});
