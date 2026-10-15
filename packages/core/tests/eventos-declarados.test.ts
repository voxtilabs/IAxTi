import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';
import { emisoresDeEventos, eventosSinEmisor } from '../src/eventos-sin-emisor';
import { archivosFuente } from '../src/testing/archivos';
import { fuenteLimpia } from '../src/testing/fuente-limpia';

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
};
// `permission.denied` estuvo acá esperando una decisión y la decisión fue
// sacarlo del contrato (#793): no es un evento, es la acción de auditoría que
// escribe el guard. Una excepción anotada era lo correcto mientras se decidía,
// pero una excepción permanente habría dejado el manifiesto prometiendo para
// siempre un evento que nadie iba a emitir, con la guarda en verde diciendo que
// eso estaba bajo control. La aserción de «la lista no junta polvo» de más
// abajo es la que obliga a que las dos cosas se muevan juntas.

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

/**
 * `consumes: ['*']` dice «consumo el catálogo entero» (#783). Hoy lo declara
 * `integrations`, y es verdad: el fan-out de webhooks salientes recibe
 * `registry.eventsCatalog()` y entrega cualquier evento publicado al que el
 * tenant le haya suscrito un endpoint.
 *
 * ## Por qué necesita caso aparte y no puede caer en el `includes`
 *
 * Porque la comprobación de abajo busca el nombre del evento ENTRE COMILLAS en
 * el código del módulo, y `'*'` no es un nombre: es un comodín. Medido antes de
 * escribir esto, la cadena `'*'` aparece exactamente una vez en lo que esta
 * guarda escanea, en `apps/web/components/bandeja/bandeja.tsx`:
 *
 * ```tsx
 * .on('broadcast', { event: '*' }, (msg) => { … })
 * ```
 *
 * Una suscripción de realtime de la bandeja, que no tiene nada que ver con el
 * manifiesto de `integrations`. Con ella, `'*'` pasaba la guarda POR ACCIDENTE;
 * el día que alguien toque esa línea de la bandeja, la guarda se pone roja
 * acusando a `integrations`. Las dos direcciones son mentira.
 *
 * ## Y por qué no un `continue` a secas
 *
 * Porque entonces `'*'` sería la única entrada de `consumes` que nadie
 * comprueba, y la lección de `eventos-sin-emisor.ts` es justo ésa: una guarda
 * que no mide no se ve apagada, se ve verde. Lo que sostiene el `'*'` es que el
 * fan-out universal esté REGISTRADO en el despachador; si desaparece de ahí,
 * `integrations` deja de consumir todo y los 52 eventos que ningún manifiesto
 * nombra vuelven a ser huérfanos de verdad. Eso es lo que se exige.
 *
 * ## Lo que esto deja escrito, que era el tercer criterio de #783
 *
 * Que la guarda de eventos huérfanos no se puede escribir, y no por falta de
 * datos: con un consumidor universal declarado, TODO evento publicado está
 * consumido, y la pregunta «¿a este evento lo escucha alguien?» no se contesta
 * leyendo los manifiestos. Lo que sí se puede guardar es que el comodín no
 * mienta, que es esta prueba.
 */
const CONSUMO_UNIVERSAL = '*';

/** La forma exacta con la que el despachador consume el catálogo entero. */
const FAN_OUT_UNIVERSAL = 'webhookConsumers(registry.eventsCatalog())';

describe('los eventos que se declaran consumir tienen quien los consuma', () => {
  it('cada `consumes` del manifiesto aparece en el código de su módulo', () => {
    const modulesDir = findModulesDir();
    const raiz = join(modulesDir, '..', '..');
    const huerfanos: string[] = [];

    // LIMPIO (#569): un consumidor comentado no consume, y la exigencia del
    // comodín —que el fan-out siga registrado— se satisfaría con la línea
    // comentada, que es el modo de falla más fácil de dejar sin querer.
    //
    // Y `apps` se lee UNA vez, no una por módulo: son siete los manifiestos
    // con `consumes` no vacío, el árbol es el mismo para todos, y leerlo siete
    // veces costaba siete limpiezas del repo entero. Dentro del bucle, esta
    // prueba se pasaba de los 5 s de vitest cuando la máquina tenía otra cosa
    // corriendo al lado, y una guarda que falla por lenta se lee como una
    // guarda que falla.
    const limpio = (f: string): string => fuenteLimpia(readFileSync(f, 'utf8'));
    const deApps = archivosFuente(join(raiz, 'apps')).map(limpio).join('\n');

    for (const manifest of loadAllManifests(modulesDir)) {
      const consumidos = manifest.events?.consumes ?? [];
      if (consumidos.length === 0) continue;
      const delModulo = archivosFuente(join(modulesDir, manifest.module.id)).map(limpio);
      const codigo = [deApps, ...delModulo].join('\n');
      for (const evento of consumidos) {
        if (evento === CONSUMO_UNIVERSAL) {
          if (!codigo.includes(FAN_OUT_UNIVERSAL)) {
            huerfanos.push(
              `${CONSUMO_UNIVERSAL} (lo declara ${manifest.module.id} y ya nadie entrega el ` +
                `catálogo entero: falta \`${FAN_OUT_UNIVERSAL}\` en el despachador)`,
            );
          }
          continue;
        }
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

  /**
   * Anti-vacuidad, como las tres de la guarda de emisores: la de arriba es un
   * `toEqual([])` y una lista vacía la satisface también cuando dejó de mirar.
   */
  it('hay un módulo declarando el comodín y el despachador lo respalda', () => {
    const universales = loadAllManifests(findModulesDir()).filter((m) =>
      (m.events?.consumes ?? []).includes(CONSUMO_UNIVERSAL),
    );
    expect(universales.map((m) => m.module.id)).toEqual(['integrations']);

    const main = fuenteLimpia(
      readFileSync(join(findModulesDir(), '..', '..', 'apps', 'workers', 'src', 'main.ts'), 'utf8'),
    );
    expect(main).toContain(FAN_OUT_UNIVERSAL);
  });
});
