import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  aplicarEstadoDelProveedor,
  createTemplate,
  enviarPlantilla,
  getTemplate,
  marcarEnviadaARevision,
  updateTemplate,
} from '../application/plantillas';
import { envioDePlantilla } from '../application/zavu-plantillas';

/**
 * El enlace con el proveedor (#44).
 *
 * Nuestro uuid no le sirve a nadie: el proveedor conoce la plantilla por el id
 * que él le dio al registrarla (`provider_id`), y ese es el único dato con el
 * que se puede mandar. Dos cosas se rompían por no cuidar ese enlace:
 *
 *  1. el snapshot que queda pegado al mensaje no lo copiaba, así que el
 *     adaptador reventaba con el mensaje ya en la cola y NINGUNA plantilla
 *     salía nunca — ni el envío manual ni el recordatorio de cita;
 *  2. corregir una rechazada conservaba el enlace viejo, y la revisión
 *     siguiente hacía que Meta revisara otra vez el texto ya rechazado.
 *
 * Las dos son de la misma familia: quién es esta plantilla para el proveedor.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
let conversacion: string;

const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

const base = {
  language: 'es_CL',
  category: 'utility' as const,
  body: 'Hola {{1}}, te recordamos tu hora del {{2}}. ¿La confirmas?',
};

/** Deja la plantilla aprobada, con o sin el id del proveedor. */
async function aprobada(nombre: string, providerId?: string): Promise<string> {
  const p = await en((c) => createTemplate(c, { tenantId: tenant, name: nombre, ...base }));
  await en((c) =>
    marcarEnviadaARevision(c, { tenantId: tenant, templateId: p.id, providerId }),
  );
  await en((c) =>
    aplicarEstadoDelProveedor(c, {
      tenantId: tenant,
      name: p.name,
      language: p.language,
      status: 'approved',
    }),
  );
  return p.id;
}

/** Rechazada por Meta y con enlace al proveedor: lista para corregir. */
async function rechazada(nombre: string, providerId: string): Promise<string> {
  const p = await en((c) => createTemplate(c, { tenantId: tenant, name: nombre, ...base }));
  await en((c) =>
    marcarEnviadaARevision(c, { tenantId: tenant, templateId: p.id, providerId }),
  );
  await en((c) =>
    aplicarEstadoDelProveedor(c, {
      tenantId: tenant,
      name: p.name,
      language: p.language,
      status: 'rejected',
      reason: 'El pie parece promocional para una plantilla de utilidad.',
    }),
  );
  return p.id;
}

let mensajesCreados = 0;

const deps = {
  contactoDe: async () => contacto,
  puedeIniciar: async () => true,
  crearMensaje: async (m: { tenantId: string; conversationId: string; body: string }) => {
    mensajesCreados += 1;
    const r = await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind)
       VALUES ($1, $2, 'out', 'texto', $3, 'user') RETURNING id`,
      [m.tenantId, m.conversationId, m.body],
    );
    return { id: r.rows[0].id as string };
  },
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name) VALUES ('plantillas-enlace') RETURNING id",
  );
  tenant = t.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin)
     VALUES ($1, 'Ana', '+56966660077', 'whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;
  // Cinco días fría: fuera de la ventana de 24 h, que es donde la plantilla es
  // la única vía que deja Meta.
  const conv = await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel, last_inbound_at)
     VALUES ($1, $2, 'whatsapp', now() - interval '5 days') RETURNING id`,
    [tenant, contacto],
  );
  conversacion = conv.rows[0].id;
  // Migraciones y fixture contra la base compartida de desarrollo: los 10 s
  // por defecto no alcanzan cuando hay otra suite corriendo encima.
}, 180_000);

afterAll(async () => {
  await admin.end();
});

describe('el snapshot que queda pegado al mensaje', () => {
  it('lleva el id del proveedor, que es lo único con lo que el adaptador puede mandarla', async () => {
    const id = await aprobada('recordatorio con enlace', 'tpl_zavu_9');
    const res = await en((c) =>
      enviarPlantilla(
        c,
        { tenantId: tenant, conversationId: conversacion, templateId: id, valores: ['Ana', 'martes 10:30'] },
        deps,
      ),
    );

    const msg = await admin.query('SELECT type, meta FROM messages WHERE id = $1', [res.messageId]);
    const snapshot = msg.rows[0].meta.plantilla as Record<string, unknown>;
    expect(msg.rows[0].type).toBe('plantilla');
    expect(snapshot.providerId).toBe('tpl_zavu_9');

    // Lo que importa no es el campo: es que el adaptador pueda armar el envío
    // con ESTE snapshot. Sin `providerId` esto lanzaba, y lanzaba con el
    // mensaje ya encolado: cinco reintentos y «mándala a revisión primero» de
    // una plantilla que Meta había aprobado.
    expect(envioDePlantilla(snapshot as { providerId?: string | null; valores?: string[] })).toEqual({
      messageType: 'template',
      content: {
        templateId: 'tpl_zavu_9',
        templateVariables: { '1': 'Ana', '2': 'martes 10:30' },
      },
    });
  });

  it('una aprobada sin enlace no se encola: se rechaza diciendo qué hacer', async () => {
    const id = await aprobada('recordatorio sin enlace');
    const antes = mensajesCreados;
    await expect(
      en((c) =>
        enviarPlantilla(
          c,
          { tenantId: tenant, conversationId: conversacion, templateId: id, valores: ['Ana', 'hoy'] },
          deps,
        ),
      ),
    ).rejects.toThrow(/no quedó enlazada con el proveedor.*Mándala a revisión de nuevo/s);
    // Y no deja un mensaje colgado en la cola para fallar cinco veces.
    expect(mensajesCreados).toBe(antes);
  });
});

describe('corregir una rechazada', () => {
  it('suelta el enlace, para que la revisión mande el texto NUEVO', async () => {
    const id = await rechazada('cotizacion mal escrita', 'tpl_zavu_viejo');
    const corregida = await en((c) =>
      updateTemplate(c, {
        tenantId: tenant,
        templateId: id,
        body: 'Hola {{1}}, tu cotización del {{2}} está lista. ¿La revisamos?',
      }),
    );

    expect(corregida.status).toBe('draft');
    // Con el enlace puesto, `POST /plantillas/:id/revision` entra por
    // `enviarARevision`, que manda solo el id y la categoría: Meta vuelve a
    // revisar el texto viejo y la rechaza por lo mismo. Sin enlace pasa por
    // `crear`, que sí manda el cuerpo corregido.
    expect(corregida.providerId).toBeNull();
    expect(await en((c) => getTemplate(c, tenant, id))).toMatchObject({ providerId: null });
  });

  it('pero cambiar solo la categoría lo conserva: esa sí viaja en cada revisión', async () => {
    const id = await rechazada('aviso de categoria', 'tpl_zavu_cat');
    const corregida = await en((c) =>
      updateTemplate(c, { tenantId: tenant, templateId: id, category: 'marketing' }),
    );

    expect(corregida.category).toBe('marketing');
    // Soltar el enlace acá obligaría a registrar un duplicado con el mismo
    // nombre e idioma en el proveedor, y eso el proveedor lo rechaza.
    expect(corregida.providerId).toBe('tpl_zavu_cat');
  });
});
