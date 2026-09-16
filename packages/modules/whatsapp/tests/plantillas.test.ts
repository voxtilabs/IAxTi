import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  normalizarNombre,
  renderizar,
  validarPlantilla,
  type PlantillaBorrador,
} from '../domain/plantillas';
import {
  aplicarEstadoDelProveedor,
  createTemplate,
  enviarPlantilla,
  listTemplates,
  marcarEnviadaARevision,
  prepararEnvio,
  updateTemplate,
} from '../application/plantillas';

// Plantillas (#44). Fuera de la ventana de 24 h es lo ÚNICO que Meta deja
// salir: sin esto una conversación que se enfrió no se retoma nunca.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

const base: PlantillaBorrador = {
  name: 'recordatorio de hora',
  language: 'es_CL',
  category: 'utility',
  body: 'Hola {{1}}, te recordamos tu hora del {{2}}. ¿La confirmas?',
  footer: 'Responde SALIR para no recibir más',
};

const en = <T>(fn: (c: never) => Promise<T>) => withTenant(admin, tenant, fn as never);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('plantillas-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('las reglas de forma de Meta, validadas acá', () => {
  it('el nombre viaja como identificador: minúsculas y guion bajo', () => {
    expect(normalizarNombre('Recordatorio de Hora')).toBe('recordatorio_de_hora');
    expect(normalizarNombre('  Cotización N° 5 ')).toBe('cotizacion_n_5');
    expect(() => normalizarNombre('   ')).toThrow(/nombre/);
  });

  it('las variables van desde {{1}} y sin saltos', () => {
    expect(() => validarPlantilla({ ...base, body: 'Hola {{1}}, lo de {{3}} está listo.' })).toThrow(
      /sin saltos/,
    );
  });

  it('dos variables seguidas no se aprueban', () => {
    expect(() => validarPlantilla({ ...base, body: 'Hola {{1}} {{2}} ya está.' })).toThrow(
      /Dos variables seguidas/,
    );
  });

  it('el cuerpo no empieza ni termina con variable', () => {
    expect(() => validarPlantilla({ ...base, body: '{{1}} tu pedido llegó.' })).toThrow(/empezar/);
    expect(() => validarPlantilla({ ...base, body: 'Tu pedido llegó, {{1}}' })).toThrow(/terminar/);
  });

  it('el pie no admite variables y el encabezado admite una sola', () => {
    expect(() => validarPlantilla({ ...base, footer: 'Chao {{1}}' })).toThrow(/pie no admite/);
    expect(() => validarPlantilla({ ...base, header: '{{1}} y {{2}}' })).toThrow(/una sola variable/);
  });

  it('el idioma va como es o es_CL', () => {
    expect(() => validarPlantilla({ ...base, language: 'castellano' })).toThrow(/es_CL/);
  });

  it('renderizar exige exactamente los valores que la plantilla pide', () => {
    expect(renderizar(base.body, ['Ana', 'martes 10:30'])).toContain('Hola Ana, te recordamos tu hora del martes 10:30');
    expect(() => renderizar(base.body, ['Ana'])).toThrow(/necesita 2 valores y llegaron 1/);
  });
});

describe('el ciclo de una plantilla', () => {
  let id: string;

  it('nace en borrador y no se puede enviar', async () => {
    const p = await en((c) => createTemplate(c, { tenantId: tenant, ...base }));
    id = p.id;
    expect(p.status).toBe('draft');
    expect(p.name).toBe('recordatorio_de_hora');
    expect(p.variables).toBe(2);

    await expect(
      en((c) => prepararEnvio(c, { tenantId: tenant, templateId: id, valores: ['Ana', 'hoy'] })),
    ).rejects.toThrow(/todavía no se manda a revisión/);
  });

  it('el mismo nombre e idioma no se repite', async () => {
    await expect(en((c) => createTemplate(c, { tenantId: tenant, ...base }))).rejects.toThrow(
      /Ya existe una plantilla/,
    );
  });

  it('en revisión tampoco sale, y no se edita', async () => {
    await en((c) => marcarEnviadaARevision(c, { tenantId: tenant, templateId: id, providerId: 'wa_tpl_1' }));
    await expect(
      en((c) => prepararEnvio(c, { tenantId: tenant, templateId: id, valores: ['Ana', 'hoy'] })),
    ).rejects.toThrow(/en revisión/);
    await expect(
      en((c) => updateTemplate(c, { tenantId: tenant, templateId: id, body: 'Otra cosa {{1}} más' })),
    ).rejects.toThrow(/no se edita/);
  });

  it('rechazada muestra el motivo y se puede corregir', async () => {
    await en((c) =>
      aplicarEstadoDelProveedor(c, {
        tenantId: tenant,
        name: 'recordatorio_de_hora',
        language: 'es_CL',
        status: 'rejected',
        reason: 'El pie parece promocional para una plantilla de utilidad.',
      }),
    );
    const rechazada = (await en((c) => listTemplates(c, tenant))).find((p) => p.id === id)!;
    expect(rechazada.status).toBe('rejected');
    expect(rechazada.rejectionReason).toContain('promocional');

    // Corregirla la devuelve a borrador y limpia el motivo.
    const corregida = await en((c) =>
      updateTemplate(c, { tenantId: tenant, templateId: id, footer: 'Equipo de la clínica' }),
    );
    expect(corregida.status).toBe('draft');
    expect(corregida.rejectionReason).toBeNull();
  });

  it('aprobada sí sale, con los valores puestos', async () => {
    await en((c) => marcarEnviadaARevision(c, { tenantId: tenant, templateId: id }));
    await en((c) =>
      aplicarEstadoDelProveedor(c, {
        tenantId: tenant,
        name: 'recordatorio_de_hora',
        language: 'es_CL',
        status: 'approved',
      }),
    );
    const { texto, plantilla } = await en((c) =>
      prepararEnvio(c, { tenantId: tenant, templateId: id, valores: ['Ana', 'martes 10:30'] }),
    );
    expect(plantilla.status).toBe('approved');
    expect(texto).toBe('Hola Ana, te recordamos tu hora del martes 10:30. ¿La confirmas?');
  });

  it('Meta la puede pausar sola, y ahí deja de salir', async () => {
    await en((c) =>
      aplicarEstadoDelProveedor(c, {
        tenantId: tenant,
        name: 'recordatorio_de_hora',
        language: 'es_CL',
        status: 'paused',
        reason: 'calidad baja',
      }),
    );
    await expect(
      en((c) => prepararEnvio(c, { tenantId: tenant, templateId: id, valores: ['Ana', 'hoy'] })),
    ).rejects.toThrow(/pausada por calidad/);
  });

  it('un aviso de una plantilla ajena se ignora sin romper nada', async () => {
    const res = await en((c) =>
      aplicarEstadoDelProveedor(c, {
        tenantId: tenant,
        name: 'plantilla_de_otro',
        language: 'es_CL',
        status: 'approved',
      }),
    );
    expect(res).toBeNull();
  });
});

describe('enviar una plantilla: se salta la ventana, nada más', () => {
  let contacto: string;
  let conversacion: string;
  let aprobada: string;

  beforeAll(async () => {
    const c = await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Ana', '+56966660001', 'whatsapp') RETURNING id`,
      [tenant],
    );
    contacto = c.rows[0].id;
    const conv = await admin.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel, last_inbound_at)
       VALUES ($1, $2, 'whatsapp', now() - interval '5 days') RETURNING id`,
      [tenant, contacto],
    );
    conversacion = conv.rows[0].id;

    const p = await en((c2) =>
      createTemplate(c2, {
        tenantId: tenant,
        name: 'volvemos a escribir',
        language: 'es_CL',
        category: 'marketing',
        body: 'Hola {{1}}, tenemos novedades para contarte. ¿Conversamos?',
      }),
    );
    aprobada = p.id;
    await en((c2) => marcarEnviadaARevision(c2, { tenantId: tenant, templateId: aprobada }));
    await en((c2) =>
      aplicarEstadoDelProveedor(c2, {
        tenantId: tenant,
        name: 'volvemos_a_escribir',
        language: 'es_CL',
        status: 'approved',
      }),
    );
  });

  const deps = (opciones: { consiente: boolean }) => ({
    contactoDe: async () => contacto,
    puedeIniciar: async () => opciones.consiente,
    crearMensaje: async (m: { tenantId: string; conversationId: string; body: string }) => {
      const r = await admin.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind)
         VALUES ($1, $2, 'out', 'texto', $3, 'user') RETURNING id`,
        [m.tenantId, m.conversationId, m.body],
      );
      return { id: r.rows[0].id as string };
    },
  });

  it('sale aunque la conversación lleve cinco días fría: para eso existe', async () => {
    const res = await en((c) =>
      enviarPlantilla(
        c,
        { tenantId: tenant, conversationId: conversacion, templateId: aprobada, valores: ['Ana'] },
        deps({ consiente: true }),
      ),
    );
    expect(res.texto).toContain('Hola Ana');

    const msg = await admin.query('SELECT type, meta FROM messages WHERE id = $1', [res.messageId]);
    // Queda marcado como plantilla y con cuál: el adaptador la necesita, y
    // un reintento de la cola tiene que mandar exactamente la misma.
    expect(msg.rows[0].type).toBe('plantilla');
    expect(msg.rows[0].meta.plantilla.name).toBe('volvemos_a_escribir');
    expect(msg.rows[0].meta.plantilla.valores).toEqual(['Ana']);
  });

  it('pero NO se salta el consentimiento', async () => {
    await expect(
      en((c) =>
        enviarPlantilla(
          c,
          { tenantId: tenant, conversationId: conversacion, templateId: aprobada, valores: ['Ana'] },
          deps({ consiente: false }),
        ),
      ),
    ).rejects.toThrow('SIN_CONSENTIMIENTO');
  });

  it('ni manda una que no está aprobada', async () => {
    const borrador = await en((c) =>
      createTemplate(c, {
        tenantId: tenant,
        name: 'sin aprobar todavia',
        language: 'es_CL',
        category: 'utility',
        body: 'Hola {{1}}, esto no debería salir nunca.',
      }),
    );
    await expect(
      en((c) =>
        enviarPlantilla(
          c,
          { tenantId: tenant, conversationId: conversacion, templateId: borrador.id, valores: ['Ana'] },
          deps({ consiente: true }),
        ),
      ),
    ).rejects.toThrow(/no se manda a revisión/);
  });
});
