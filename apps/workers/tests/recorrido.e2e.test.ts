import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound, isWithinWindow, sendMessage } from '@iaxti/module-conversations';
import { canReceiveBusinessInitiated, createPipeline, createDeal, createTag, setContactTags } from '@iaxti/module-crm';
import { agendar, cambiarEstadoCita, definirDisponibilidad, huecosDelDia } from '@iaxti/module-calendar';
import {
  aplicarEstadoDelProveedor,
  createTemplate,
  enviarPlantilla,
  marcarEnviadaARevision,
} from '@iaxti/module-whatsapp';
import { crearCampana, iniciarCampana, previsualizarSegmento } from '@iaxti/module-automations';
import { procesarLoteDeCampana } from '../src/campanas';
import { exportarTenant } from '@iaxti/module-organizations';

/**
 * El recorrido completo de una pyme, con las piezas reales.
 *
 * Cada una de estas partes tiene sus propios tests. Lo que este comprueba es
 * que ENCAJEN: escribió una clienta, se le hizo una cotización, se le agendó
 * una hora, no llegó, se la volvió a contactar fuera de ventana con una
 * plantilla y después entró en una campaña a la cartera.
 *
 * Es el camino donde aparecen los huecos entre módulos — los que ningún test
 * de un módulo solo puede ver.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const duena = randomUUID();

// Tipado de verdad y no con `as never` (#507): el casteo era para callar al
// compilador, y callaba TODO el archivo — cada resultado salía `unknown`, así
// que ningún `expect` sobre una propiedad estaba comprobando nada.
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan, timezone) VALUES ('recorrido-completo', 'crece', 'America/Santiago') RETURNING id",
  );
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('el recorrido de una clienta, de punta a punta', () => {
  let contacto: string;
  let conversacion: string;
  let plantilla: string;

  it('1. escribe por WhatsApp y queda como contacto con conversación abierta', async () => {
    const res = await en((c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '+56955551212',
        channel: 'whatsapp',
        body: 'Hola, ¿cuánto sale el corte con color?',
      }),
    );
    contacto = res.contact.id;
    conversacion = res.conversation.id;
    expect(res.conversation.state).toBe('new');

    // Escribió ella: hay consentimiento y la ventana está abierta.
    expect(await en((c) => canReceiveBusinessInitiated(c, tenant, contacto))).toBe(true);
    expect(isWithinWindow('whatsapp', res.conversation.lastInboundAt)).toBe(true);
  });

  it('2. se le responde y se le abre una oportunidad', async () => {
    await en((c) =>
      sendMessage(c, {
        tenantId: tenant,
        conversationId: conversacion,
        authorKind: 'user',
        authorId: duena,
        body: 'Hola! El corte con color sale $45.000. ¿Te agendo?',
      }),
    );
    const pipe = await en((c) =>
      createPipeline(c, {
        tenantId: tenant,
        name: 'Ventas',
        stages: [
          { name: 'Cotizado', type: 'open' },
          { name: 'Ganado', type: 'won' },
          { name: 'Perdido', type: 'lost' },
        ],
      }),
    );
    const trato = await en((c) =>
      createDeal(c, {
        tenantId: tenant,
        contactId: contacto,
        pipelineId: pipe.pipeline.id,
        title: 'Corte con color',
        value: 45000,
      }),
    );
    expect(trato.id).toBeTruthy();

    // Y se la etiqueta para poder encontrarla después.
    const tag = await en((c) => createTag(c, { tenantId: tenant, name: 'Cotizó', role: 'info' }));
    await en((c) =>
      setContactTags(c, { tenantId: tenant, contactId: contacto, tagIds: [tag.id], actor: duena }),
    );
  });

  it('3. se le agenda una hora en el horario real del negocio', async () => {
    await en((c) =>
      definirDisponibilidad(c, {
        tenantId: tenant,
        ownerId: duena,
        weekday: 1,
        inicioMin: 600,
        finMin: 720,
        duracion: 60,
        anticipacionMin: 0,
      }),
    );
    const huecos = await en((c) =>
      huecosDelDia(c, {
        tenantId: tenant,
        ownerId: duena,
        dia: '2027-03-01',
        ahora: new Date('2027-02-01T12:00:00Z'),
      }),
    );
    expect(huecos.length).toBeGreaterThan(0);

    const cita = await en((c) =>
      agendar(c, {
        tenantId: tenant,
        contactId: contacto,
        ownerId: duena,
        inicio: huecos[0].inicio,
        fin: huecos[0].fin,
        title: 'Corte con color',
        conversationId: conversacion,
        confirmada: true,
      }),
    );

    // No llegó: el evento sale y queda para que una regla lo escuche.
    await en((c) => cambiarEstadoCita(c, { tenantId: tenant, appointmentId: cita.id, to: 'no_show' }));
    const evento = await admin.query(
      `SELECT count(*)::int n FROM outbox WHERE tenant_id = $1 AND name = 'appointment.no_show'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('4. pasan los días, la ventana se cierra, y solo sale una plantilla', async () => {
    await admin.query(
      "UPDATE conversations SET last_inbound_at = now() - interval '5 days' WHERE id = $1",
      [conversacion],
    );
    const conv = await admin.query('SELECT last_inbound_at FROM conversations WHERE id = $1', [conversacion]);
    expect(isWithinWindow('whatsapp', conv.rows[0].last_inbound_at)).toBe(false);

    const p = await en((c) =>
      createTemplate(c, {
        tenantId: tenant,
        name: 'te extrañamos',
        language: 'es_CL',
        category: 'marketing',
        body: 'Hola {{1}}, te guardamos tu hora para cuando quieras. ¿Te reagendo?',
      }),
    );
    plantilla = p.id;

    // Sin aprobar no sale: es lo que Meta exige y lo que el código respeta.
    await expect(
      en((c) =>
        enviarPlantilla(
          c,
          { tenantId: tenant, conversationId: conversacion, templateId: plantilla, valores: ['Ana'] },
          {
            contactoDe: async () => contacto,
            puedeIniciar: () => Promise.resolve(true),
            crearMensaje: async () => ({ id: 'no-deberia-llegar' }),
          },
        ),
      ),
    ).rejects.toThrow(/no se manda a revisión/);

    // Con el id del proveedor, como queda en la vida real: la revisión la
    // registra allá y ese id es lo único con lo que el adaptador puede
    // mandarla. Sin él `enviarPlantilla` se niega antes de encolar nada.
    await en((c) =>
      marcarEnviadaARevision(c, { tenantId: tenant, templateId: plantilla, providerId: 'tpl_prov_e2e' }),
    );
    await en((c) =>
      aplicarEstadoDelProveedor(c, {
        tenantId: tenant,
        name: 'te_extranamos',
        language: 'es_CL',
        status: 'approved',
      }),
    );

    const envio = await en((c) =>
      enviarPlantilla(
        c,
        { tenantId: tenant, conversationId: conversacion, templateId: plantilla, valores: ['Ana'] },
        {
          contactoDe: async () => contacto,
          puedeIniciar: (id) => canReceiveBusinessInitiated(c as never, tenant, id),
          crearMensaje: (m) =>
            sendMessage(c as never, {
              tenantId: m.tenantId,
              conversationId: m.conversationId,
              authorKind: 'user',
              body: m.body,
            }),
        },
      ),
    );
    expect(envio.texto).toContain('Hola Ana');
  });

  it('5. entra en una campaña a la cartera, y la campaña la encuentra', async () => {
    const vista = await en((c) =>
      previsualizarSegmento(c, { tenantId: tenant, filtros: {} }),
    );
    expect(vista.total, 'el segmento no encontró a la clienta').toBe(1);

    const campana = await en((c) =>
      crearCampana(c, {
        tenantId: tenant,
        name: 'Reactivación de marzo',
        templateId: plantilla,
        filtros: {},
        // El nombre de CADA persona, no el de la primera de la lista.
        valores: ['{contacto.nombre}'],
      }),
    );
    /**
     * Dos pasos desde #609: lanzar deja la campaña lista, y el LOTE la manda.
     *
     * Y el lote se corre con `procesarLoteDeCampana`, que es el código que corre
     * en producción, en vez de armar los `deps` acá. La versión anterior de esta
     * prueba los escribía a mano y les faltaba `delivery: 'business'` — o sea que
     * medía un camino parecido al real con la política de envío equivocada, que
     * es justo lo que la prueba de abajo viene a cuidar.
     */
    await en((c) =>
      iniciarCampana(
        c,
        { tenantId: tenant, campaignId: campana.id },
        { calidadDelNumero: async () => 'verde' },
      ),
    );
    const res = await procesarLoteDeCampana(admin, {
      moduleId: 'automations',
      tenantId: tenant,
      campaignId: campana.id,
    });
    expect(res.encolados, `la campaña no encoló: ${JSON.stringify(res.motivos)}`).toBe(1);

    /**
     * Y el mensaje del destinatario sale con política de NEGOCIO (#380).
     *
     * Esto vivía en `apps/api/tests/entrega-durable.test.ts`, y ahí ya no se
     * puede comprobar: desde #609 lanzar una campaña no crea mensajes —los crea
     * el lote, en el worker— así que la prueba de la API habría quedado pidiendo
     * destinatarios que el request no produce. Acá sí corre el lote, con los
     * mismos `deps` que usa producción.
     *
     * Por qué importa la política: `business` es la que respeta el horario de
     * silencio, la ventana de 24 h y el consentimiento. Un mensaje de campaña
     * marcado como `reply` saldría a las 2 de la mañana.
     */
    const destinatarios = await admin.query(
      `SELECT message_id FROM campaign_recipients
        WHERE tenant_id = $1 AND campaign_id = $2 AND message_id IS NOT NULL`,
      [tenant, campana.id],
    );
    expect(destinatarios.rowCount).toBe(1);
    const pedido = await admin.query(
      `SELECT payload FROM outbox
        WHERE tenant_id = $1 AND name = 'message.delivery_requested'
          AND payload->>'messageId' = $2`,
      [tenant, destinatarios.rows[0].message_id],
    );
    expect(pedido.rows.map((f) => (f.payload as { policy: string }).policy)).toEqual(['business']);
  });

  it('6. y el negocio se puede llevar todo lo suyo', async () => {
    const e = await en((c) => exportarTenant(c, { tenantId: tenant }));
    expect(e.resumen.contacts).toBe(1);
    expect(e.resumen.messages).toBeGreaterThan(2);
    expect(e.resumen.deals).toBe(1);
    expect(e.resumen.appointments).toBe(1);
    expect(e.resumen.campaigns).toBe(1);
    expect(e.resumen.whatsapp_templates).toBe(1);
    expect(e.truncadas).toEqual([]);
    // Y en el archivo está la conversación, que es lo que de verdad le importa.
    expect(JSON.stringify(e.datos.messages)).toContain('corte con color');
  });
});
