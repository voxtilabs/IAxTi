import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { previsualizarSegmento, guardarSegmento, listarSegmentos } from '../application/segmentos';
import {
  crearCampana,
  enviarCampana,
  listarCampanas,
  previsualizarCampana,
  resultadosDeCampana,
} from '../application/campanas';

/**
 * Envíos segmentados (#75). Lo que se prueba acá es sobre todo a quién NO
 * se le manda: la función que más rápido puede arruinar la reputación de un
 * negocio es esta.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let etiqueta: string;
const plantilla = randomUUID();
const conversaciones = new Map<string, string>();
const sinConsentimiento = new Set<string>();

const en = <T>(fn: (c: never) => Promise<T>) => withTenant(admin, tenant, fn as never);

async function nuevoContacto(nombre: string, opciones: { etiqueta?: boolean; optOut?: boolean; diasSinActividad?: number } = {}) {
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin, opted_out_at, last_activity_at)
     VALUES ($1, $2, $3, 'whatsapp', $4, now() - make_interval(days => $5)) RETURNING id`,
    [
      tenant,
      nombre,
      `+5699${Math.floor(1000000 + Math.random() * 8999999)}`,
      opciones.optOut ? new Date() : null,
      opciones.diasSinActividad ?? 0,
    ],
  );
  const id = c.rows[0].id as string;
  if (opciones.etiqueta) {
    await admin.query(
      'INSERT INTO contact_tags (tenant_id, contact_id, tag_id) VALUES ($1, $2, $3)',
      [tenant, id, etiqueta],
    );
  }
  const conv = await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`,
    [tenant, id],
  );
  conversaciones.set(id, conv.rows[0].id);
  return id;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('campanas-test') RETURNING id");
  tenant = t.rows[0].id;
  const tag = await admin.query(
    `INSERT INTO tags (tenant_id, name, role) VALUES ($1, 'Cotizó', 'info') RETURNING id`,
    [tenant],
  );
  etiqueta = tag.rows[0].id;

  await nuevoContacto('Cotizó hace 40 días', { etiqueta: true, diasSinActividad: 40 });
  await nuevoContacto('Cotizó ayer', { etiqueta: true, diasSinActividad: 1 });
  const sinOptIn = await nuevoContacto('Se dio de baja', { etiqueta: true, diasSinActividad: 40, optOut: true });
  sinConsentimiento.add(sinOptIn);
  await nuevoContacto('Nunca cotizó', { diasSinActividad: 60 });
});

afterAll(async () => {
  await admin.end();
});

const deps = (calidad: 'verde' | 'amarillo' | 'rojo' = 'verde') => ({
  calidadDelNumero: async () => calidad,
  puedeIniciar: async (contactId: string) => !sinConsentimiento.has(contactId),
  conversacionDe: async (contactId: string) => conversaciones.get(contactId) ?? null,
  enviarPlantilla: async ({ conversationId }: { conversationId: string }) => {
    const r = await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind, delivery_status)
       VALUES ($1, $2, 'out', 'plantilla', 'Hola, tenemos novedades', 'user', 'queued') RETURNING id`,
      [tenant, conversationId],
    );
    return { messageId: r.rows[0].id as string };
  },
});

describe('el segmento', () => {
  it('cuenta y muestra a quién le llegaría, con la MISMA consulta del envío', async () => {
    const vista = await en((c) =>
      previsualizarSegmento(c, {
        tenantId: tenant,
        filtros: { tagIds: [etiqueta], sinActividadDias: 30 },
      }),
    );
    // Solo "Cotizó hace 40 días": el de ayer tiene actividad reciente y el
    // que se dio de baja no entra ni a la vista previa.
    expect(vista.total).toBe(1);
    expect(vista.muestra[0].name).toBe('Cotizó hace 40 días');
  });

  it('quien se dio de baja no aparece nunca, ni en el conteo', async () => {
    const vista = await en((c) =>
      previsualizarSegmento(c, { tenantId: tenant, filtros: { tagIds: [etiqueta] } }),
    );
    expect(vista.muestra.map((m) => m.name)).not.toContain('Se dio de baja');
    expect(vista.total).toBe(2);
  });

  it('se guarda con nombre para volver a usarlo', async () => {
    await en((c) =>
      guardarSegmento(c, {
        tenantId: tenant,
        name: 'Cotizaron y no compraron',
        filtros: { tagIds: [etiqueta], sinActividadDias: 30 },
      }),
    );
    const lista = await en((c) => listarSegmentos(c, tenant));
    expect(lista.map((s) => s.name)).toContain('Cotizaron y no compraron');
  });
});

describe('la campaña', () => {
  let campana: string;

  beforeAll(async () => {
    const c = await en((c2) =>
      crearCampana(c2, {
        tenantId: tenant,
        name: 'Promo septiembre',
        templateId: plantilla,
        filtros: { tagIds: [etiqueta] },
      }),
    );
    campana = c.id;
  });

  it('la vista previa de la campaña dice lo mismo que la del segmento', async () => {
    const vista = await en((c) => previsualizarCampana(c, { tenantId: tenant, campaignId: campana }));
    expect(vista.total).toBe(2);
  });

  it('con el número en ROJO no sale: es la forma más corta de perderlo', async () => {
    await expect(
      en((c) => enviarCampana(c, { tenantId: tenant, campaignId: campana }, deps('rojo'))),
    ).rejects.toThrow(/calidad ROJA/);
  });

  it('sale, y cada destinatario queda con su resultado', async () => {
    const res = await en((c) =>
      enviarCampana(c, { tenantId: tenant, campaignId: campana }, deps('amarillo')),
    );
    expect(res.encolados).toBe(2);
    expect(res.saltados).toBe(0);

    const filas = await admin.query(
      'SELECT status, count(*)::int n FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status',
      [campana],
    );
    expect(filas.rows.find((f) => f.status === 'queued')?.n).toBe(2);
  });

  it('no se manda dos veces, ni aunque se dispare de nuevo', async () => {
    await expect(
      en((c) => enviarCampana(c, { tenantId: tenant, campaignId: campana }, deps())),
    ).rejects.toThrow(/ya está cerrada/);
  });

  it('los resultados dicen qué pasó con cada uno', async () => {
    const r = await en((c) => resultadosDeCampana(c, { tenantId: tenant, campaignId: campana }));
    expect(r.porEstado.queued).toBe(2);
    expect(r.entrega.queued).toBe(2); // todavía en la cola
    expect(r.costoUsd).toBe(0);
  });

  it('a quien no consintió se le SALTA con motivo, no se le manda', async () => {
    // Una campaña sin filtro de etiqueta alcanza también a los otros.
    const abierta = await en((c) =>
      crearCampana(c, { tenantId: tenant, name: 'A toda la cartera', templateId: plantilla, filtros: {} }),
    );
    // Se le quita el consentimiento a uno que sí entra al segmento.
    const unos = await admin.query(
      "SELECT id FROM contacts WHERE tenant_id = $1 AND name = 'Nunca cotizó'",
      [tenant],
    );
    sinConsentimiento.add(unos.rows[0].id);

    const res = await en((c) =>
      enviarCampana(c, { tenantId: tenant, campaignId: abierta.id }, deps()),
    );
    expect(res.saltados).toBeGreaterThanOrEqual(1);
    expect(res.motivos['sin consentimiento']).toBeGreaterThanOrEqual(1);

    const r = await en((c) => resultadosDeCampana(c, { tenantId: tenant, campaignId: abierta.id }));
    expect(r.motivos.some((m) => m.motivo === 'sin consentimiento')).toBe(true);
  });
});

describe('el listado', () => {
  it('trae las campañas del negocio, la más reciente primero', async () => {
    const { campanas } = await en((c) => listarCampanas(c, tenant));
    expect(campanas.length).toBeGreaterThanOrEqual(2);
    const fechas = campanas.map((c) => c.createdAt);
    expect([...fechas].sort().reverse()).toEqual(fechas);
    expect(campanas[0].name).toBeTruthy();
  });

  it('el conteo por resultado viene en la misma consulta, sin abrir cada una', async () => {
    // Es la razón de ser del listado: una lista que solo diga 'enviada'
    // obliga a entrar una por una para saber si salió bien.
    const { campanas } = await en((c) => listarCampanas(c, tenant));
    const conEnvio = campanas.find((c) => c.destinatarios.encolados > 0);
    expect(conEnvio, 'ninguna campaña con destinatarios encolados').toBeTruthy();
    const r = await en((c) =>
      resultadosDeCampana(c, { tenantId: tenant, campaignId: conEnvio!.id }),
    );
    expect(conEnvio!.destinatarios.encolados).toBe(r.porEstado.queued ?? 0);
    expect(conEnvio!.destinatarios.saltados).toBe(r.porEstado.skipped ?? 0);
  });

  it('el tenant de al lado no ve ninguna', async () => {
    const otro = (
      await admin.query("INSERT INTO tenants (name) VALUES ('campanas-vecino') RETURNING id")
    ).rows[0].id as string;
    const { campanas } = await withTenant(admin, otro, (c) => listarCampanas(c, otro));
    expect(campanas).toEqual([]);
  });

  it('avisa cuando corta: una lista truncada no se ve igual que una completa', async () => {
    const corta = await en((c) => listarCampanas(c, tenant, { limite: 1 }));
    expect(corta.campanas).toHaveLength(1);
    expect(corta.truncado).toBe(true);

    const entera = await en((c) => listarCampanas(c, tenant, { limite: 100 }));
    expect(entera.truncado).toBe(false);
  });

  it('un límite absurdo no tumba la consulta', async () => {
    for (const limite of [0, -5, 9999, Number.NaN]) {
      const r = await en((c) => listarCampanas(c, tenant, { limite }));
      expect(r.campanas.length).toBeGreaterThan(0);
      expect(r.campanas.length).toBeLessThanOrEqual(100);
    }
  });
});
