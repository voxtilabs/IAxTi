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
