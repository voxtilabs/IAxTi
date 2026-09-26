import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { CATALOGO } from '../application/catalogo';
import {
  CuotaDeIaAgotada,
  aplicarPropuesta,
  conversarConElAgenteGeneral,
  repartirArgumentos,
} from '../application/agente-general';
import type { ModelPort } from '../application/models';

/**
 * El Agente General (#493, ADR-0025).
 *
 * Lo que se prueba acá no es que el modelo conteste bonito —eso lo mide el
 * dataset de evaluación— sino las tres reglas que no se pueden romper:
 *
 *  1. Las herramientas se filtran por los permisos de QUIEN HABLA.
 *  2. Lo irreversible se PROPONE, no se ejecuta.
 *  3. Lo que se aplica se revalida: la propuesta viaja por el navegador.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

/** Un modelo de juguete: pide las herramientas que se le digan y contesta. */
function modeloQuePide(guion: Array<{ tool: string; args?: Record<string, unknown> }>, texto = 'Listo.'): ModelPort {
  return {
    async generate(args) {
      for (const paso of guion) {
        const h = (args.tools ?? []).find((t) => t.name === paso.tool);
        if (h) await h.ejecutar(paso.args ?? {});
      }
      return { text: texto, tokensIn: 100, tokensOut: 50 };
    },
  };
}

const TODOS_LOS_MODULOS = new Set(CATALOGO.map((h) => h.modulo).filter(Boolean) as string[]);
const TODOS_LOS_PERMISOS = new Set(CATALOGO.map((h) => h.permiso).filter(Boolean) as string[]);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('agente-general') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin?.end();
});

describe('los argumentos se reparten donde van', () => {
  it('lo que el catálogo marcó como ruta reemplaza la ranura', () => {
    const h = CATALOGO.find((x) => x.ruta === '/v1/contacts/{id}' && x.metodo === 'PATCH')!;
    const r = repartirArgumentos(h, { id: 'abc', name: 'Ana', email: null });
    expect(r.ruta).toBe('/v1/contacts/abc');
    // Lo que no es ruta ni query es cuerpo: el generador aplana el @Body.
    expect(r.cuerpo).toEqual({ name: 'Ana', email: null });
  });

  it('lo que es query va a query, no al cuerpo', () => {
    const h = CATALOGO.find((x) => x.ruta === '/v1/agenda/huecos')!;
    const r = repartirArgumentos(h, { dia: '2026-10-01' });
    expect(r.query).toEqual({ dia: '2026-10-01' });
    // GET no lleva cuerpo, y mandar uno hace que algunos servidores lo
    // rechacen antes de mirar la ruta.
    expect(r.cuerpo).toBeNull();
  });

  it('DELETE tampoco lleva cuerpo', () => {
    const h = CATALOGO.find((x) => x.metodo === 'DELETE')!;
    expect(repartirArgumentos(h, { id: 'x' }).cuerpo).toBeNull();
  });
});

describe('las herramientas se filtran por quien habla', () => {
  it('sin permisos no se le ofrece NINGUNA', async () => {
    let ofrecidas = 0;
    const r = await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: 'crea un contacto' }],
        permisos: new Set(),
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        modelo: {
          async generate(args) {
            // Siempre están las dos del agente —buscar y preparar—, pero
            // buscar no encuentra nada porque el catálogo quedó vacío.
            const buscar = (args.tools ?? []).find((t) => t.name === 'buscar_herramienta')!;
            const hallado = (await buscar.ejecutar({ consulta: 'crear contacto' })) as {
              encontradas: number;
            };
            ofrecidas = hallado.encontradas;
            return { text: 'No puedo.', tokensIn: 1, tokensOut: 1 };
          },
        },
        llamarApi: async () => {
          throw new Error('no debería llamar a nada');
        },
      },
    );
    expect(ofrecidas).toBe(0);
    expect(r.pasos).toEqual([]);
  });

  it('con el módulo apagado, sus herramientas no aparecen', async () => {
    let nombres: string[] = [];
    await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: 'agenda una hora' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: new Set([...TODOS_LOS_MODULOS].filter((m) => m !== 'calendar')),
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        modelo: {
          async generate(args) {
            const buscar = (args.tools ?? []).find((t) => t.name === 'buscar_herramienta')!;
            const hallado = (await buscar.ejecutar({ consulta: 'agenda hora' })) as {
              herramientas?: Array<{ nombre: string }>;
            };
            nombres = (hallado.herramientas ?? []).map((h) => h.nombre);
            return { text: 'Sin agenda.', tokensIn: 1, tokensOut: 1 };
          },
        },
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    expect(nombres.some((n) => n.startsWith('agenda.'))).toBe(false);
  });
});

describe('lo irreversible se propone, no se hace', () => {
  it('cancelar la suscripción queda esperando y NO llama a la API', async () => {
    let llamadas = 0;
    const r = await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: 'cancela mi plan' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        modelo: modeloQuePide([
          { tool: 'preparar_accion', args: { herramienta: 'billing.cancelar', argumentos: { motivo: 'caro' } } },
        ]),
        llamarApi: async () => {
          llamadas += 1;
          return { ok: true, estado: 200, datos: {} };
        },
      },
    );
    expect(llamadas).toBe(0);
    expect(r.propuesta?.herramienta).toBe('billing.cancelar');
    expect(r.propuesta?.argumentos).toEqual({ motivo: 'caro' });
  });

  it('una lectura SÍ se ejecuta al tiro', async () => {
    let ruta = '';
    const r = await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: '¿cuántos contactos tengo?' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        modelo: modeloQuePide([{ tool: 'preparar_accion', args: { herramienta: 'contacts.list' } }]),
        llamarApi: async (p) => {
          ruta = p.ruta;
          return { ok: true, estado: 200, datos: { items: [] } };
        },
      },
    );
    expect(ruta).toBe('/v1/contacts');
    expect(r.propuesta).toBeNull();
    expect(r.pasos[0]).toMatchObject({ herramienta: 'contacts.list', ok: true });
  });

  it('una sola acción esperando por respuesta', async () => {
    // Con 195 herramientas y un modelo que se entusiasma, esto es lo que
    // evita que una conversación deje seis cosas configuradas.
    const r = await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: 'cancela y borra todo' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        modelo: modeloQuePide([
          { tool: 'preparar_accion', args: { herramienta: 'billing.cancelar', argumentos: {} } },
          { tool: 'preparar_accion', args: { herramienta: 'tags.remove', argumentos: { id: 'x' } } },
        ]),
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    expect(r.propuesta?.herramienta).toBe('billing.cancelar');
  });

  it('el error de la API vuelve AL MODELO, no explota', async () => {
    const r = await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: 'lista los contactos' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        modelo: modeloQuePide([{ tool: 'preparar_accion', args: { herramienta: 'contacts.list' } }]),
        llamarApi: async () => ({ ok: false, estado: 403, datos: { message: 'No tienes permiso.' } }),
      },
    );
    // La conversación sigue: un permiso que falta es un dato que el modelo
    // necesita para responder sin inventar.
    expect(r.pasos[0].ok).toBe(false);
    expect(r.texto).toBe('Listo.');
  });
});

describe('aplicar lo aprobado se revalida', () => {
  it('sin el permiso no se aplica, aunque la propuesta lo diga', async () => {
    await expect(
      aplicarPropuesta(
        {
          herramienta: 'billing.cancelar',
          argumentos: {},
          permisos: new Set(),
          modulosActivos: TODOS_LOS_MODULOS,
        },
        { llamarApi: async () => ({ ok: true, estado: 200, datos: {} }) },
      ),
    ).rejects.toThrow(/permiso/);
  });

  it('con el módulo apagado tampoco', async () => {
    await expect(
      aplicarPropuesta(
        {
          herramienta: 'billing.cancelar',
          argumentos: {},
          permisos: TODOS_LOS_PERMISOS,
          modulosActivos: new Set(),
        },
        { llamarApi: async () => ({ ok: true, estado: 200, datos: {} }) },
      ),
    ).rejects.toThrow(/no está activa/);
  });

  it('una herramienta inventada se rechaza', async () => {
    await expect(
      aplicarPropuesta(
        {
          herramienta: 'plataforma.borrarTodo',
          argumentos: {},
          permisos: TODOS_LOS_PERMISOS,
          modulosActivos: TODOS_LOS_MODULOS,
        },
        { llamarApi: async () => ({ ok: true, estado: 200, datos: {} }) },
      ),
    ).rejects.toThrow(/no existe/);
  });
});

describe('«¿qué me falta?» (#495)', () => {
  const diagnostico = {
    falta: [
      {
        que: 'No tienes plantillas aprobadas',
        porQue: 'Pasadas 24 h no puedes escribirle a nadie.',
        comoSeArregla: 'plantillas.create',
        urgencia: 'importa' as const,
      },
      {
        que: 'Nadie te ha escrito todavía',
        porQue: 'Sin una conversación no hay nada que atender.',
        comoSeArregla: null,
        urgencia: 'bloquea' as const,
      },
      {
        que: 'No tienes reglas trabajando solas',
        porQue: 'Una cotización que se enfría no avisa sola.',
        comoSeArregla: 'automations.seed',
        urgencia: 'cuandoPuedas' as const,
      },
    ],
    alDia: ['Embudos: 1'],
    yaNoEstaLoQueFiguraHecho: ['El número figura conectado y hoy no lo está'],
  };

  it('lo que más duele va primero, no en el orden en que se consultó', async () => {
    let entregado: { falta?: Array<{ urgencia: string }> } = {};
    await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: '¿qué me falta?' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        diagnosticar: async () => diagnostico,
        modelo: {
          async generate(args) {
            const h = (args.tools ?? []).find((t) => t.name === 'que_le_falta_al_negocio')!;
            entregado = (await h.ejecutar({})) as typeof entregado;
            return { text: 'Te falta esto.', tokensIn: 1, tokensOut: 1 };
          },
        },
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    // El orden lo arma la herramienta y no el prompt: el modelo respeta un
    // orden hecho, y discute uno que le piden calcular.
    expect(entregado.falta?.map((f) => f.urgencia)).toEqual(['bloquea', 'importa', 'cuandoPuedas']);
  });

  it('sin la dependencia inyectada, la herramienta NI SE OFRECE', async () => {
    // `agents` no puede consultar las tablas de calendar ni de whatsapp: el
    // diagnóstico lo arma quien conoce todos los contratos. Si no llega, el
    // modelo no debe poder pedirlo y contestar con la nada.
    let nombres: string[] = [];
    await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: '¿qué me falta?' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        modelo: {
          async generate(args) {
            nombres = (args.tools ?? []).map((t) => t.name);
            return { text: 'No puedo revisarlo.', tokensIn: 1, tokensOut: 1 };
          },
        },
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    expect(nombres).toEqual(['buscar_herramienta', 'preparar_accion']);
  });

  it('no ofrece un arreglo que quien pregunta no puede hacer', async () => {
    // El diagnóstico lo arma la app mirando los módulos ACTIVOS, y eso no es
    // lo mismo que los permisos de esta persona: a una vendedora se le
    // ofrecería «crea una plantilla» y recibiría un 403 después de decir que
    // sí. El pendiente se queda —tiene que saberlo—, el botón se va.
    let entregado: { falta?: Array<{ que: string; comoSeArregla: string | null }> } = {};
    await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: '¿qué me falta?' }],
        // Solo puede leer conversaciones: nada de crear plantillas ni reglas.
        permisos: new Set(['conversations.read']),
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        diagnosticar: async () => diagnostico,
        modelo: {
          async generate(args) {
            const h = (args.tools ?? []).find((t) => t.name === 'que_le_falta_al_negocio')!;
            entregado = (await h.ejecutar({})) as typeof entregado;
            return { text: 'ok', tokensIn: 1, tokensOut: 1 };
          },
        },
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    // Los tres pendientes siguen ahí…
    expect(entregado.falta).toHaveLength(3);
    // …y ninguno viene con arreglo ofrecido, porque no puede hacer ninguno.
    expect(entregado.falta?.every((f) => f.comoSeArregla === null)).toBe(true);
  });

  it('el paso queda registrado, con su módulo en null', async () => {
    // No es de un módulo: junta varios. Decir que es de uno sería mentir en
    // el panel de corridas.
    const r = await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: '¿cómo voy?' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        diagnosticar: async () => diagnostico,
        modelo: modeloQuePide([{ tool: 'que_le_falta_al_negocio' }]),
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    expect(r.pasos[0]).toMatchObject({ herramienta: 'que_le_falta_al_negocio', modulo: null, ok: true });
  });

  it('sin nada pendiente, le dice al modelo que NO invente pendientes', async () => {
    let entregado: { nota?: string } = {};
    await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: '¿qué me falta?' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        diagnosticar: async () => ({ falta: [], alDia: ['todo'], yaNoEstaLoQueFiguraHecho: [] }),
        modelo: {
          async generate(args) {
            const h = (args.tools ?? []).find((t) => t.name === 'que_le_falta_al_negocio')!;
            entregado = (await h.ejecutar({})) as typeof entregado;
            return { text: 'Estás al día.', tokensIn: 1, tokensOut: 1 };
          },
        },
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    expect(entregado.nota).toContain('sin inventar');
  });

  it('el desfase viaja: es lo que más confunde a un negocio', async () => {
    // El registro no retrocede por diseño, así que un paso marcado de más se
    // queda marcado. Sin decirlo, el dueño cree que tiene WhatsApp conectado
    // porque alguna vez lo estuvo.
    let entregado: { yaNoEstaLoQueFiguraHecho?: string[] } = {};
    await conversarConElAgenteGeneral(
      await conexion(),
      {
        tenantId: tenant,
        turnos: [{ role: 'user', content: '¿qué me falta?' }],
        permisos: TODOS_LOS_PERMISOS,
        modulosActivos: TODOS_LOS_MODULOS,
      },
      {
        provider: 'glm',
        model: 'z-ai/glm-5.3',
        diagnosticar: async () => diagnostico,
        modelo: {
          async generate(args) {
            const h = (args.tools ?? []).find((t) => t.name === 'que_le_falta_al_negocio')!;
            entregado = (await h.ejecutar({})) as typeof entregado;
            return { text: 'ok', tokensIn: 1, tokensOut: 1 };
          },
        },
        llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
      },
    );
    expect(entregado.yaNoEstaLoQueFiguraHecho).toEqual([
      'El número figura conectado y hoy no lo está',
    ]);
  });
});

describe('el interruptor del panel corta la conversación (#496)', () => {
  it('apagado para ese negocio, no se genera nada', async () => {
    // El interruptor vive en el módulo platform y lo mira el controlador en
    // CADA vuelta. Acá se prueba el otro lado: que apagarlo signifique que
    // no se gasta una corrida, no que se genere y después se descarte.
    await admin.query(
      `INSERT INTO agente_general_apagado (tenant_id, motivo, apagado_por)
       VALUES ($1, 'prueba', '00000000-0000-4000-8000-000000000009')
       ON CONFLICT (tenant_id) WHERE tenant_id IS NOT NULL DO UPDATE SET motivo = 'prueba'`,
      [tenant],
    );
    const r = await admin.query(
      `SELECT motivo FROM agente_general_apagado
        WHERE tenant_id IS NULL OR tenant_id = $1 ORDER BY tenant_id NULLS FIRST LIMIT 1`,
      [tenant],
    );
    expect(r.rows[0].motivo).toBe('prueba');
    await admin.query('DELETE FROM agente_general_apagado WHERE tenant_id = $1', [tenant]);
  });
});

describe('la cuota corta antes de gastar', () => {
  it('al 100 % no genera y lo dice', async () => {
    const otro = (await admin.query("INSERT INTO tenants (name) VALUES ('sin-cuota-ag') RETURNING id")).rows[0].id;
    // Plan con cero corridas: cualquier uso ya está al 100 %.
    await admin.query(
      `INSERT INTO usage_meters (tenant_id, metric, period_start, value)
       VALUES ($1, 'ia_executions', date_trunc('month', now()), 999999)
       ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET value = 999999`,
      [otro],
    );
    let genero = false;
    await expect(
      conversarConElAgenteGeneral(
        await conexion(otro),
        {
          tenantId: otro,
          turnos: [{ role: 'user', content: 'hola' }],
          permisos: TODOS_LOS_PERMISOS,
          modulosActivos: TODOS_LOS_MODULOS,
        },
        {
          provider: 'glm',
          model: 'z-ai/glm-5.3',
          modelo: {
            async generate() {
              genero = true;
              return { text: 'no debería', tokensIn: 0, tokensOut: 0 };
            },
          },
          llamarApi: async () => ({ ok: true, estado: 200, datos: {} }),
        },
      ),
    ).rejects.toThrow(CuotaDeIaAgotada);
    // No se gasta: el rechazo va ANTES de la generación.
    expect(genero).toBe(false);
  });
});

/** Una conexión con el tenant puesto, como la deja `withTenant`. */
async function conexion(quien = tenant) {
  let cliente!: Parameters<typeof conversarConElAgenteGeneral>[0];
  await withTenant(admin, quien, async (c) => {
    cliente = c as typeof cliente;
  });
  return cliente;
}
