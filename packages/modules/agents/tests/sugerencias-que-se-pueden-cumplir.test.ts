import { describe, expect, it } from 'vitest';
import { CATALOGO, herramientasPara, sugerenciasPara } from '../application/catalogo';
import { SUGERENCIAS, SUGERENCIA_DE_ULTIMO_RECURSO } from '../domain/sugerencias';

/**
 * Ninguna sugerencia que falle al tocarla (#584).
 *
 * El issue lo advirtió antes de que las sugerencias existieran:
 *
 *   «Tres pastillas escritas a mano serían otra cosa declarada en un lado: si
 *    mañana el módulo de pagos está apagado para ese negocio, "crea un link de
 *    cobro" no funciona, y una sugerencia que falla al tocarla es peor que
 *    ninguna.»
 *
 * Y el aviso no se aplicó: nacieron en `apps/web/lib/donde-estoy.ts` como
 * listas fijas por pantalla. Medido el 12-10: `USER_PERMS` tiene `agents.use`
 * y **no** `automations.manage`, así que un vendedor en la bandeja veía
 * «Deriva a una persona cuando el cliente se enoja» y el agente le contestaba
 * que no puede — sus herramientas se filtran por permiso.
 */
const TODO = {
  permisos: new Set(CATALOGO.map((h) => h.permiso).filter(Boolean) as string[]),
  modulosActivos: new Set(CATALOGO.map((h) => h.modulo).filter(Boolean) as string[]),
};

/** Lo que un vendedor tiene de verdad (`USER_PERMS` de `base-roles.ts`). */
const DE_UN_VENDEDOR = new Set([
  'tenant.read',
  'crm.contacts.read',
  'crm.contacts.create',
  'crm.contacts.update',
  'crm.deals.read',
  'crm.deals.create',
  'crm.deals.update',
  'crm.deals.close',
  'crm.activities.manage',
  'crm.companies.read',
  'conversations.read',
  'conversations.reply',
  'conversations.resolve',
  'conversations.notes',
  'notifications.manage_own',
  'agents.use',
]);

describe('toda sugerencia nombra una herramienta que existe', () => {
  const nombres = new Set(CATALOGO.map((h) => h.nombre));

  it('la guarda está mirando algo', () => {
    // Anti-vacuidad: si el catálogo o la lista quedaran vacíos, lo de abajo
    // pasaría sin medir nada.
    expect(SUGERENCIAS.length).toBeGreaterThan(20);
    expect(nombres.size).toBeGreaterThan(100);
  });

  it.each([...SUGERENCIAS, SUGERENCIA_DE_ULTIMO_RECURSO])(
    '«$texto» → $herramienta existe en el catálogo',
    ({ herramienta }) => {
      // Si una herramienta se renombra, esto se cae acá y no en la cara de
      // alguien que tocó la pastilla.
      expect(nombres.has(herramienta), `"${herramienta}" no está en el catálogo`).toBe(true);
    },
  );

  it('y ninguna nombra algo que el Agente General no puede llamar nunca', () => {
    // `NO_SON_HERRAMIENTA` existe por razones fuertes —webhooks, el simulador,
    // el tope de cobro—. Ofrecer una de ésas sería una pastilla que ni con
    // todos los permisos funciona.
    const disponibles = new Set(herramientasPara(TODO).map((h) => h.nombre));
    const imposibles = SUGERENCIAS.filter((s) => !disponibles.has(s.herramienta));
    expect(
      imposibles.map((s) => `${s.texto} → ${s.herramienta}`),
      'Estas sugerencias nombran herramientas que el agente no puede llamar ni con todos los ' +
        'permisos: están en la lista curada de «nunca», o su módulo no existe.',
    ).toEqual([]);
  });
});

describe('a cada quien lo que puede (#584)', () => {
  it('EL CASO: un vendedor en la bandeja NO recibe la de automatizaciones', () => {
    const conTodo = sugerenciasPara({ pantalla: 'bandeja', ...TODO });
    const deVendedor = sugerenciasPara({
      pantalla: 'bandeja',
      permisos: DE_UN_VENDEDOR,
      modulosActivos: TODO.modulosActivos,
    });

    // Con todos los permisos sí se ofrece: así la prueba no pasa por estar
    // la frase mal escrita.
    expect(conTodo).toContain('Deriva a una persona cuando el cliente se enoja');
    // Y al vendedor no, porque le falta `automations.manage`.
    expect(deVendedor).not.toContain('Deriva a una persona cuando el cliente se enoja');
    // Pero sí lo que sabe hacer: contestar.
    expect(deVendedor).toContain('Contéstale a los que llevan más de un día esperando');
  });

  it('un módulo apagado se lleva sus sugerencias', () => {
    const sinPagos = new Set([...TODO.modulosActivos].filter((m) => m !== 'payments'));
    const s = sugerenciasPara({ pantalla: 'cobros', permisos: TODO.permisos, modulosActivos: sinPagos });
    expect(s).not.toContain('Mándale un link de pago a quien cerró ayer');
  });

  it('nunca devuelve la caja vacía: cae al último recurso', () => {
    // Alguien que solo puede usar el copiloto y leer su negocio. Ninguna
    // sugerencia de «cobros» le sirve, pero «¿qué me falta configurar?» sí.
    const s = sugerenciasPara({
      pantalla: 'cobros',
      permisos: new Set(['tenant.read', 'agents.use']),
      modulosActivos: TODO.modulosActivos,
    });
    expect(s).toHaveLength(1);
    expect(s[0]).toBe(SUGERENCIA_DE_ULTIMO_RECURSO.texto);
  });

  it('no son un menú: tres o cuatro, no dieciocho', () => {
    for (const pantalla of [...new Set(SUGERENCIAS.map((s) => s.pantalla))]) {
      const s = sugerenciasPara({ pantalla, ...TODO });
      expect(s.length, `${pantalla} ofrece ${s.length}`).toBeLessThanOrEqual(4);
      expect(s.length, `${pantalla} no ofrece ninguna con todos los permisos`).toBeGreaterThan(0);
    }
  });

  /**
   * Esta afirmación venía de #509 y vivía en `apps/web/tests/donde-estoy`,
   * mirando la lista fija. Se mudó con la lista: el defecto que caza es que el
   * popup ofreciera «¿cuánto gasté en IA este mes?» también en plantillas,
   * donde se lee como una curiosidad en vez de la forma de trabajar.
   */
  it('cada pantalla ofrece lo suyo, no los mismos de siempre', () => {
    const pantallas = [...new Set(SUGERENCIAS.map((s) => s.pantalla))];
    const juegos = new Map(
      pantallas.map((p) => [p, sugerenciasPara({ pantalla: p, ...TODO }).join(' | ')]),
    );
    const distintos = new Set(juegos.values());
    expect(
      distintos.size,
      `Hay ${pantallas.length} pantallas y solo ${distintos.size} juegos de sugerencias`,
    ).toBeGreaterThanOrEqual(12);
  });

  /**
   * La promesa del producto, en la puerta (#1003).
   *
   * `inicio` es la primera pantalla de un negocio nuevo y ofrecía cuatro
   * sugerencias, ninguna de crear un asistente: el caso estrella solo estaba
   * en la pantalla `asistente`, a la que se llega entrando a Ajustes → IA. O
   * sea que lo descubría quien ya sabía que existía.
   *
   * Las dos afirmaciones son las que importan y van juntas: que estén, y que
   * estén PRIMERAS. `sugerenciasPara` corta en cuatro, así que agregarlas al
   * final no habría cambiado nada — y una prueba que solo mirara que están
   * habría pasado igual.
   */
  it('la pantalla de inicio ofrece crear un asistente, y lo ofrece primero', () => {
    const s = sugerenciasPara({ pantalla: 'inicio', ...TODO });
    expect(s[0]).toBe('Creame un asistente que conteste mis mensajes');
    expect(s[1]).toBe('Dejame el CRM listo para mi rubro');
  });

  it('y a quien no puede configurar agentes no se le ofrecen', () => {
    // La elegibilidad sigue saliendo del catálogo: las dos piden
    // `agents.configure`, que un vendedor no tiene. Ofrecer algo que el agente
    // después no puede hacer es el defecto que #584 vino a sacar.
    const s = sugerenciasPara({
      pantalla: 'inicio',
      permisos: DE_UN_VENDEDOR,
      modulosActivos: TODO.modulosActivos,
    });
    expect(s).not.toContain('Creame un asistente que conteste mis mensajes');
    expect(s).not.toContain('Dejame el CRM listo para mi rubro');
  });

  it('una pantalla que no existe no revienta: cae al último recurso', () => {
    const s = sugerenciasPara({ pantalla: 'pantalla-inventada', ...TODO });
    expect(s).toEqual([SUGERENCIA_DE_ULTIMO_RECURSO.texto]);
  });
});
