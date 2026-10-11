import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';
import { emisoresDeEventos, eventosSinEmisor } from '../src/eventos-sin-emisor';
import { archivosFuente } from '../src/testing/archivos';

/**
 * Cada módulo declara en su `module.yaml` los eventos que PUBLICA. Nada
 * comprobaba que alguien los publicara de verdad.
 *
 * Un evento declarado y nunca emitido no falla: simplemente no pasa nada.
 * Quien escriba un consumidor confiando en el manifiesto se queda esperando
 * para siempre, y el manifiesto —que es el contrato entre módulos— deja de
 * ser creíble.
 *
 * Los que todavía no existen van en la lista de abajo CON SU MOTIVO, igual
 * que las tablas cross-tenant de la cobertura de RLS.
 */
const SIN_PRODUCTOR: Record<string, string> = {
  'template.approved':
    'Las plantillas con aprobación de Meta son #44; el evento espera a que exista el flujo.',
  'template.rejected': 'Ídem #44.',
  'user.registered':
    'El registro vive en Supabase Auth; el evento llega cuando conectemos su webhook (#7).',
  'user.login_failed':
    'Hoy el intento fallido se cuenta en Redis desde el guard (#71); el evento llega con el webhook de Supabase (#7).',
  'permission.denied':
    'Hoy el rechazo se escribe en el libro de auditoría y el panel de seguridad lo lee de ahí (#72): ' +
    'una fuente, no dos. El evento está declarado en el manifiesto y en ADR-0008, y no hace falta ' +
    'mientras nadie lo consuma — decidir si se emite o se saca del contrato es #793.',
};

describe('los eventos declarados tienen quien los publique', () => {
  it('cada `publishes` del manifiesto tiene un emisor de verdad', () => {
    const modulesDir = findModulesDir();
    const raiz = join(modulesDir, '..', '..');
    const declarados = loadAllManifests(modulesDir).flatMap((m) =>
      (m.events?.publishes ?? [])
        .filter((e) => !(e in SIN_PRODUCTOR))
        .map((e) => ({ evento: e, modulo: m.module.id })),
    );

    const sinEmisor = new Set(
      eventosSinEmisor(
        [join(raiz, 'packages'), join(raiz, 'apps')],
        declarados.map((d) => d.evento),
      ),
    );
    const huerfanos = declarados
      .filter((d) => sinEmisor.has(d.evento))
      .map((d) => `${d.evento} (declarado por ${d.modulo})`);

    expect(
      huerfanos,
      `eventos declarados que no emite nadie:\n  ${huerfanos.join('\n  ')}\n` +
        'Publícalo donde corresponda, o anótalo en SIN_PRODUCTOR con su motivo.',
    ).toEqual([]);
  });

  /**
   * Las tres de abajo son contra la vacuidad, y existen porque la versión
   * anterior de esta guarda estaba verde con dos huérfanos puestos: su
   * aserción era `toEqual([])`, que una lista vacía satisface también cuando
   * el escáner se quedó ciego. Una guarda necesita al menos una aserción
   * POSITIVA que no pueda pasar por omisión.
   */
  it('una emisión de verdad cuenta como emisor, escrita directa o por un mapa', () => {
    const directa = {
      ruta: 'directa.ts',
      texto: `await publishEvent(client, { name: 'tenant.created', tenantId: id });`,
    };
    const porMapa = {
      ruta: 'mapa.ts',
      texto:
        `const EVENTO = { active: 'channel.connected' };
` +
        `await publishEvent(client, { name: EVENTO[estado], tenantId: id });`,
    };
    const emisores = emisoresDeEventos(
      [directa, porMapa],
      ['tenant.created', 'channel.connected'],
    );
    expect(emisores.get('tenant.created')).toBe('directa.ts');
    expect(emisores.get('channel.connected')).toBe('mapa.ts');
  });

  it('el registro del CONSUMIDOR no cuenta como emisor, ni en un archivo que sí emite', () => {
    // La forma exacta que tenía engañada a la guarda: `retention.ts` registra
    // el consumidor de `tenant.plan_changed` y publica OTRO evento, así que
    // pasaba el filtro por archivo y el `includes` lo daba por emitido.
    const consumidor = {
      ruta: 'retention.ts',
      texto:
        `return [{ name: 'conversations.retention_plan_changed', event: 'tenant.plan_changed', handler }];
` +
        `await publishEvent(client, { name: 'conversations.retention.scheduled', tenantId: id });`,
    };
    const emisores = emisoresDeEventos(
      [consumidor],
      ['tenant.plan_changed', 'conversations.retention.scheduled'],
    );
    expect(emisores.has('tenant.plan_changed')).toBe(false);
    expect(emisores.get('conversations.retention.scheduled')).toBe('retention.ts');
  });

  it('una acción de auditoría con el mismo nombre no cuenta como emisor', () => {
    const auditoria = {
      ruta: 'registrar-rechazo.ts',
      texto:
        `await writeAudit(c, { action: 'permission.denied', result: 'denied' });
` +
        `await publishEvent(client, { name: 'role.assigned', tenantId: id });`,
    };
    const consulta = {
      ruta: 'salud.ts',
      texto: `const q = \`SELECT 1 FROM audit_log WHERE action = 'permission.denied'\`;
` +
        `await publishEvent(client, { name: 'role.created', tenantId: id });`,
    };
    const emisores = emisoresDeEventos(
      [auditoria, consulta],
      ['permission.denied', 'role.assigned', 'role.created'],
    );
    expect(emisores.has('permission.denied')).toBe(false);
    expect(emisores.get('role.assigned')).toBe('registrar-rechazo.ts');
    expect(emisores.get('role.created')).toBe('salud.ts');
  });

  it('un comentario que lo nombra no cuenta como emisor', () => {
    const comentado = {
      ruta: 'pendiente.ts',
      texto:
        `// TODO: cuando exista el flujo, publicar 'template.approved' acá.
` +
        `await publishEvent(client, { name: 'template.sent', tenantId: id });`,
    };
    const emisores = emisoresDeEventos([comentado], ['template.approved', 'template.sent']);
    expect(emisores.has('template.approved')).toBe(false);
    expect(emisores.get('template.sent')).toBe('pendiente.ts');
  });

  it('la lista de excepciones no junta polvo: todas siguen declaradas', () => {
    const declarados = new Set(
      loadAllManifests(findModulesDir()).flatMap((m) => m.events?.publishes ?? []),
    );
    const sobrantes = Object.keys(SIN_PRODUCTOR).filter((e) => !declarados.has(e));
    expect(sobrantes, `excepciones de eventos que ya nadie declara: ${sobrantes.join(', ')}`).toEqual([]);
  });
});

describe('los eventos que se declaran consumir tienen quien los consuma', () => {
  it('cada `consumes` del manifiesto aparece en el código de su módulo', () => {
    const modulesDir = findModulesDir();
    const huerfanos: string[] = [];

    for (const manifest of loadAllManifests(modulesDir)) {
      const consumidos = manifest.events?.consumes ?? [];
      if (consumidos.length === 0) continue;
      const raiz = join(modulesDir, '..', '..');
      const codigo = [join(modulesDir, manifest.module.id), join(raiz, 'apps')]
        .flatMap((d) => archivosFuente(d))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      for (const evento of consumidos) {
        if (!codigo.includes(`'${evento}'`)) {
          huerfanos.push(`${evento} (lo declara ${manifest.module.id} y no lo maneja)`);
        }
      }
    }

    expect(
      huerfanos,
      `eventos declarados como consumidos sin consumidor:\n  ${huerfanos.join('\n  ')}\n` +
        'Escribe el consumidor, o sácalo del manifiesto: el catálogo es el contrato.',
    ).toEqual([]);
  });
});
