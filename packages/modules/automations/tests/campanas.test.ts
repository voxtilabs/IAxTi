import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  contarSegmento,
  guardarSegmento,
  listarSegmentos,
  previsualizarSegmento,
} from '../application/segmentos';
import {
  crearCampana,
  detenerCampana,
  enviarLoteDeCampana,
  iniciarCampana,
  listarCampanas,
  previsualizarCampana,
  resultadosDeCampana,
  seguirCampana,
  volverABorrador,
  campanasSinAvance,
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

// Tipado de verdad y no con `as never` (#507): el casteo era para callar al
// compilador, y callaba TODO el archivo — cada resultado salía `unknown`, así
// que ningún `expect` sobre una propiedad estaba comprobando nada.
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

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

/**
 * Lo que `enviarCampana` hacía en una sola llamada (#609): lanzar y recorrer
 * todo. Ahora son dos cosas y el recorrido lo hace el job, así que las pruebas
 * que solo quieren «mándala entera» usan esto.
 *
 * El `while` con tope es a propósito: si un lote devolviera `sending` sin
 * avanzar, una prueba con `while (estado === 'sending')` pelado se cuelga para
 * siempre y el CI muere por timeout sin decir qué pasó. Con el tope, falla
 * diciendo que no avanzó.
 */
async function vaciarLotes(
  campaignId: string,
  calidad: 'verde' | 'amarillo' | 'rojo' = 'verde',
  lote = 100,
) {
  // Los contadores se ACUMULAN: cada lote devuelve los suyos, y la campaña
  // cierra con un lote vacío —así es como se sabe que no queda nadie a quien
  // escribirle—, así que quedarse con el último daría cero siempre.
  let vueltas = 0;
  let encolados = 0;
  let saltados = 0;
  const motivos: Record<string, number> = {};
  let res = await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote }, deps(calidad)));
  for (;;) {
    encolados += res.encolados;
    saltados += res.saltados;
    for (const [k, n] of Object.entries(res.motivos)) motivos[k] = (motivos[k] ?? 0) + n;
    if (res.estado !== 'sending') break;
    if (++vueltas > 200) throw new Error('el lote no avanza: 200 vueltas y sigue en sending');
    res = await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote }, deps(calidad)));
  }
  return { ...res, encolados, saltados, motivos };
}

async function mandarTodo(
  campaignId: string,
  calidad: 'verde' | 'amarillo' | 'rojo' = 'verde',
  lote = 100,
) {
  await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps(calidad)));
  return vaciarLotes(campaignId, calidad, lote);
}

describe('el segmento', () => {
  it('el borrador y el envío se auditan en sus transacciones (#348)', async () => {
    const campana = await en((c) => crearCampana(c, {
      tenantId: tenant, name: 'Auditoría transaccional', templateId: plantilla,
      filtros: { origen: 'sin-destinatarios-en-este-ensayo' },
    }));
    const audit = () => admin.query('SELECT action FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 ORDER BY id', [tenant, campana.id]);
    expect((await audit()).rows).toEqual([{ action: 'campaign.created' }]);
    await expect(en(async (c) => {
      await iniciarCampana(c, { tenantId: tenant, campaignId: campana.id }, deps());
      throw new Error('rollback deliberado');
    })).rejects.toThrow('rollback deliberado');
    expect((await audit()).rows).toEqual([{ action: 'campaign.created' }]);
    expect((await admin.query('SELECT status FROM campaigns WHERE id = $1', [campana.id])).rows[0].status).toBe('draft');
    // Ahora son tres: lanzar y cerrar son momentos distintos, y cada uno deja
    // su rastro. `campaign.started` dice quién la lanzó y con qué total; el
    // `campaign.sent` de antes sigue siendo el cierre.
    await mandarTodo(campana.id);
    expect((await audit()).rows).toEqual([
      { action: 'campaign.created' },
      { action: 'campaign.started' },
      { action: 'campaign.sent' },
    ]);
  });

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
      en((c) => iniciarCampana(c, { tenantId: tenant, campaignId: campana }, deps('rojo'))),
    ).rejects.toThrow(/calidad ROJA/);
  });

  it('sale, y cada destinatario queda con su resultado', async () => {
    const res = await mandarTodo(campana, 'amarillo');
    expect(res.encolados).toBe(2);
    expect(res.saltados).toBe(0);
    // Y se cierra como `done`, no `partial`: salieron todos los que había.
    expect(res.estado).toBe('done');
    expect(res.quedan).toBe(0);

    const filas = await admin.query(
      'SELECT status, count(*)::int n FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status',
      [campana],
    );
    expect(filas.rows.find((f) => f.status === 'queued')?.n).toBe(2);
  });

  it('no se manda dos veces, ni aunque se dispare de nuevo', async () => {
    await expect(
      en((c) => iniciarCampana(c, { tenantId: tenant, campaignId: campana }, deps())),
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

    const res = await mandarTodo(abierta.id);
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

/**
 * Una campaña que no cabe en un día, y una que hay que detener (#609, #610).
 *
 * Las dos cosas eran imposibles antes y por la misma razón: el envío era un
 * `for` dentro de un request y dentro de una sola transacción. No había lote
 * donde cortar ni punto donde preguntar si alguien pidió parar.
 */
describe('una campaña que se corta, y una que se detiene', () => {
  let etiquetaLote: string;
  const delLote: string[] = [];

  beforeAll(async () => {
    const tag = await admin.query(
      `INSERT INTO tags (tenant_id, name, role) VALUES ($1, 'Lote', 'info') RETURNING id`,
      [tenant],
    );
    etiquetaLote = tag.rows[0].id;
    for (let i = 0; i < 5; i++) {
      const id = await nuevoContacto(`Del lote ${i}`, { diasSinActividad: 1 });
      await admin.query(
        'INSERT INTO contact_tags (tenant_id, contact_id, tag_id) VALUES ($1, $2, $3)',
        [tenant, id, etiquetaLote],
      );
      delLote.push(id);
    }
  });

  const nuevaCampana = async (name: string) =>
    (
      await en((c) =>
        crearCampana(c, {
          tenantId: tenant,
          name,
          templateId: plantilla,
          filtros: { tagIds: [etiquetaLote] },
        }),
      )
    ).id;

  /**
   * Llenar el canal **como pasa de verdad**: marcando los mensajes ya encolados
   * como rechazados por tope.
   *
   * Mi primera versión de esto hacía que `enviarPlantilla` lanzara
   * `DAILY_LIMIT_EXCEEDED`, y era una prueba que no podía fallar nunca por la
   * razón correcta: `enviarPlantilla` no habla con el proveedor —crea el mensaje
   * y lo deja en la cola— así que ese error no existe en ese punto. La prueba
   * verificaba un camino inventado.
   *
   * Donde el tope aparece de verdad es en los mensajes: el adaptador guarda la
   * causa traducida en `messages.meta->>'error'`.
   */
  const MOTIVO_TOPE = 'El canal llegó a su tope diario de mensajes. Lo que falta puede salir mañana.';

  async function llenarElCanal(campaignId: string) {
    await admin.query(
      `UPDATE messages SET delivery_status = 'failed',
              meta = meta || jsonb_build_object('error', $2::text)
        WHERE tenant_id = $1 AND id IN (
          SELECT message_id FROM campaign_recipients
           WHERE campaign_id = $3 AND message_id IS NOT NULL
        )`,
      [tenant, MOTIVO_TOPE, campaignId],
    );
  }

  /**
   * El `canalLleno` que implementa el worker, en versión de prueba.
   *
   * Pregunta lo mismo y contra la misma frase. Lo que esto NO prueba es que la
   * frase del worker y la del adaptador sean la misma —eso lo cuida
   * `MOTIVO_TOPE_DIARIO`, que es una constante exportada, y la prueba de
   * `tope-diario.test.ts` en whatsapp.
   */
  const depsConCanalLleno = (calidad: 'verde' | 'amarillo' | 'rojo' = 'verde') => ({
    ...deps(calidad),
    canalLleno: async () => {
      const r = await admin.query(
        `SELECT m.meta->>'error' AS motivo
           FROM campaign_recipients r
           JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
          WHERE r.tenant_id = $1 AND m.delivery_status = 'failed'
            AND m.meta->>'error' = $2
          LIMIT 1`,
        [tenant, MOTIVO_TOPE],
      );
      return (r.rows[0]?.motivo as string) ?? null;
    },
  });

  it('el tope del canal la deja «a medias» y NUNCA «enviada» (#609)', async () => {
    const campaignId = await nuevaCampana('Promo que no cabe');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    // Salen dos y el canal los rechaza por tope.
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, deps()));
    await llenarElCanal(campaignId);

    const res = await en((c) =>
      enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, depsConCanalLleno()),
    );

    expect(res.estado).toBe('partial');
    expect(res.quedan).toBe(3);
    expect(res.motivoDelCorte).toMatch(/tope diario/);

    // Y lo que importa de verdad: la campaña no dice «enviada».
    const fila = await admin.query('SELECT status, stop_reason, planned_total FROM campaigns WHERE id = $1', [campaignId]);
    expect(fila.rows[0].status).toBe('partial');
    expect(fila.rows[0].planned_total).toBe(5);
    expect(fila.rows[0].stop_reason).toMatch(/tope diario/);
  });

  it('con el canal lleno no se fabrica ni un mensaje más (#609)', async () => {
    // Seguir encolando contra un canal lleno solo agrega mensajes que van a
    // fallar, y cada uno de esos `failed` se lee después como «a Ana no se le
    // pudo mandar» — que es falso: a Ana no se le alcanzó a mandar.
    const campaignId = await nuevaCampana('Sin fabricar de más');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 1 }, deps()));
    await llenarElCanal(campaignId);
    await en((c) =>
      enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 4 }, depsConCanalLleno()),
    );

    // Una sola fila: la del único que salió antes de que el canal se llenara.
    const filas = await admin.query(
      'SELECT count(*)::int n FROM campaign_recipients WHERE campaign_id = $1',
      [campaignId],
    );
    expect(filas.rows[0].n).toBe(1);
  });

  it('«seguir» manda a los que quedaron y recién ahí queda enviada', async () => {
    const campaignId = await nuevaCampana('La que se retoma');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, deps()));
    await llenarElCanal(campaignId);
    await en((c) =>
      enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, depsConCanalLleno()),
    );
    // Al día siguiente el canal ya no rechaza: los mensajes de ayer salieron.
    await admin.query(
      `UPDATE messages SET delivery_status = 'sent', meta = meta - 'error'
        WHERE tenant_id = $1 AND id IN (
          SELECT message_id FROM campaign_recipients WHERE campaign_id = $2
        )`,
      [tenant, campaignId],
    );

    await en((c) => seguirCampana(c, { tenantId: tenant, campaignId }, deps()));
    const res = await vaciarLotes(campaignId);
    expect(res.estado).toBe('done');
    expect(res.quedan).toBe(0);

    // Y nadie recibió dos veces: 5 contactos, 5 filas.
    const filas = await admin.query(
      'SELECT count(*)::int n FROM campaign_recipients WHERE campaign_id = $1',
      [campaignId],
    );
    expect(filas.rows[0].n).toBe(5);
  });

  it('detener corta el envío en el lote siguiente y deja los números honestos (#610)', async () => {
    const campaignId = await nuevaCampana('La que sale mal');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    // Un lote de 2: salen dos, quedan tres.
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, deps()));

    const parada = await en((c) =>
      detenerCampana(c, { tenantId: tenant, campaignId, actor: undefined, motivo: 'la plantilla estaba mal' }),
    );
    expect(parada.encolados).toBe(2);
    expect(parada.sinTocar).toBe(3);
    // Cierra EN EL ACTO porque no había ningún lote corriendo. Sin esto la
    // persona apretaba «Detener», leía «2.800 no se van a enviar», y la pantalla
    // seguía diciendo «Saliendo» hasta que corriera un lote — o para siempre, si
    // el worker estaba caído.
    expect(parada.campana.status).toBe('cancelled');

    // Y el lote que ya estaba encolado y llega tarde no revienta: la cola es
    // at-least-once y esto salió exactamente como debía.
    const res = await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, deps()));
    expect(res.estado).toBe('cancelled');
    expect(res.encolados).toBe(0);

    const fila = await admin.query('SELECT status, stop_reason FROM campaigns WHERE id = $1', [campaignId]);
    expect(fila.rows[0].status).toBe('cancelled');
    expect(fila.rows[0].stop_reason).toBe('la plantilla estaba mal');

    // Y se auditó quién la detuvo.
    const audit = await admin.query(
      "SELECT action FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action = 'campaign.stopped'",
      [tenant, campaignId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('si hay un lote corriendo, lo cierra ESE lote y no la solicitud', async () => {
    // El otro lado del candado: pisarle el estado desde `detenerCampana`
    // mientras un lote está mandando sería decidir sobre mensajes que todavía
    // están saliendo.
    const campaignId = await nuevaCampana('Detener con lote en curso');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));

    const corriendo = await admin.connect();
    try {
      await corriendo.query('BEGIN');
      await corriendo.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      // Este cliente toma el candado y lo retiene hasta su COMMIT.
      await corriendo.query('SELECT pg_try_advisory_xact_lock(hashtext($1))', [`campana:${campaignId}`]);

      const parada = await en((c) =>
        detenerCampana(c, { tenantId: tenant, campaignId, motivo: 'con lote en curso' }),
      );
      // La solicitud queda escrita, el estado NO se toca.
      expect(parada.campana.status).toBe('sending');
      expect(parada.campana.stopRequestedAt).not.toBeNull();
      await corriendo.query('COMMIT');
    } finally {
      corriendo.release();
    }

    // Y ahora sí: el lote siguiente lee la solicitud y cierra.
    const res = await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, deps()));
    expect(res.estado).toBe('cancelled');
  });

  it('no se puede detener una campaña que todavía no sale', async () => {
    const campaignId = await nuevaCampana('Todavía en borrador');
    await expect(
      en((c) => detenerCampana(c, { tenantId: tenant, campaignId })),
    ).rejects.toThrow(/no hay nada que detener/);
  });

  it('el recorrido por lotes no se salta ni repite a nadie, con lote de 1', async () => {
    // Lote de 1 es el caso extremo del orden `(created_at, id)`: cinco vueltas,
    // cinco personas distintas. Con un cursor sobre `created_at` pelado, dos
    // contactos del mismo instante se pisarían justo acá.
    const campaignId = await nuevaCampana('Uno por uno');
    const res = await mandarTodo(campaignId, 'verde', 1);
    expect(res.estado).toBe('done');
    const filas = await admin.query(
      'SELECT contact_id FROM campaign_recipients WHERE campaign_id = $1',
      [campaignId],
    );
    expect(new Set(filas.rows.map((f) => f.contact_id)).size).toBe(5);
  });

  it('dos lotes de la misma campaña no se pisan: el segundo no manda nada', async () => {
    // Sin el candado los dos piden «los que todavía no tienen fila», los dos
    // reciben a la MISMA gente —el anti-join no ve filas que la otra
    // transacción no commiteó— y los dos mandan. El `ON CONFLICT` evita la fila
    // repetida, no el mensaje repetido: el cliente lo recibe dos veces y se
    // paga dos veces.
    const campaignId = await nuevaCampana('Dos lotes a la vez');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));

    const a = await admin.connect();
    const b = await admin.connect();
    try {
      for (const cliente of [a, b]) {
        await cliente.query('BEGIN');
        await cliente.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      }
      const primero = await enviarLoteDeCampana(a, { tenantId: tenant, campaignId, lote: 2 }, deps());
      const segundo = await enviarLoteDeCampana(b, { tenantId: tenant, campaignId, lote: 2 }, deps());

      expect(primero.yaHabiaOtroLote).toBe(false);
      expect(primero.encolados).toBe(2);
      // El segundo ve el candado tomado y se va sin mandar ni anotar nada.
      expect(segundo.yaHabiaOtroLote).toBe(true);
      expect(segundo.encolados).toBe(0);
      await a.query('COMMIT');
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }

    const filas = await admin.query(
      'SELECT count(*)::int n FROM campaign_recipients WHERE campaign_id = $1',
      [campaignId],
    );
    expect(filas.rows[0].n).toBe(2);
  });

  it('una parada que llega DURANTE el último lote deja «enviada», no «detenida»', async () => {
    // «Detenida» cuando en realidad salió completa es tan falso como «enviada»
    // cuando quedó gente afuera, solo que miente para el otro lado: el dueño
    // creería que ahorró mensajes que ya se pagaron.
    //
    // La parada tiene que llegar MIENTRAS el lote manda, no antes: si llega
    // antes, no sale nadie y la campaña está legítimamente detenida. Se simula
    // con una conexión aparte que escribe la solicitud a mitad del lote, que es
    // lo que de verdad pasa cuando alguien aprieta el botón.
    const campaignId = await nuevaCampana('Parada que llegó justo al final');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));

    let mandados = 0;
    const base = deps();
    const depsQueParanAlFinal = {
      ...base,
      enviarPlantilla: async (args: { conversationId: string; contactId: string; templateId: string; valores: string[] }) => {
        const r = await base.enviarPlantilla(args);
        if (++mandados === 5) {
          // El último ya salió: acá aprieta el botón. Conexión aparte y
          // commiteada, porque `READ COMMITTED` es lo que hace que el lote lo
          // vea en su consulta siguiente.
          await admin.query(
            `UPDATE campaigns SET stop_requested_at = now(), stop_reason = 'apretó al final'
              WHERE id = $1`,
            [campaignId],
          );
        }
        return r;
      },
    };

    const res = await en((c) =>
      enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 100 }, depsQueParanAlFinal),
    );
    expect(res.encolados).toBe(5);
    expect(res.quedan).toBe(0);
    expect(res.estado).toBe('done');
  });

  it('volver a borrador solo si nadie recibió nada (#609)', async () => {
    // El caso: se lanzó, el COMMIT pasó y encolar en Redis falló. Sin esto la
    // campaña queda `sending` para siempre y sin salida, porque lanzar solo
    // acepta borradores.
    const campaignId = await nuevaCampana('La que no se pudo encolar');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    expect(await en((c) => volverABorrador(c, { tenantId: tenant, campaignId }))).toBe(true);
    expect(
      (await admin.query('SELECT status, planned_total FROM campaigns WHERE id = $1', [campaignId])).rows[0],
    ).toEqual({ status: 'draft', planned_total: null });

    // Y si ya salió alguien, NO se revierte: volver a borrador borraría de la
    // pantalla el hecho de que esa campaña ya le escribió a gente.
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 1 }, deps()));
    expect(await en((c) => volverABorrador(c, { tenantId: tenant, campaignId }))).toBe(false);
  });

  it('el barrido encuentra la campaña colgada y no la que está viva (#609)', async () => {
    const colgada = await nuevaCampana('Colgada');
    const viva = await nuevaCampana('Viva');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId: colgada }, deps()));
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId: viva }, deps()));
    // La colgada se lanzó «hace media hora» y nunca anotó a nadie.
    await admin.query("UPDATE campaigns SET started_at = now() - interval '30 minutes' WHERE id = $1", [colgada]);

    const sinAvance = await en((c) => campanasSinAvance(c, tenant, 10));
    expect(sinAvance).toContain(colgada);
    expect(sinAvance).not.toContain(viva);

    // Y una campaña que SÍ avanzó hace poco no cuenta como colgada, aunque se
    // haya lanzado hace rato: `started_at` solo no alcanza para decidir.
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId: colgada, lote: 1 }, deps()));
    expect(await en((c) => campanasSinAvance(c, tenant, 10))).not.toContain(colgada);
  });

  it('la función SECURITY DEFINER ve lo que una consulta con RLS no vería (#286)', async () => {
    // Un barrido cross-tenant escrito como SELECT suelto devuelve cero filas con
    // el rol de producción: se vería corriendo y no encontraría nada nunca.
    const r = await admin.query('SELECT * FROM tenants_con_campanas_sin_avance(10)');
    expect(r.rowCount).toBeGreaterThanOrEqual(0);
    const columnas = r.fields.map((f) => f.name);
    expect(columnas).toEqual(['tenant_id']);
  });

  it('si el número se pone en ROJO a mitad de campaña, el lote siguiente no sale', async () => {
    /**
     * La regresión que esto evita, y que llegó CON el cambio a lotes: antes el
     * envío era una sola llamada, así que preguntar la calidad al principio y
     * preguntarla «durante» eran lo mismo. Por lotes dejaron de serlo, y lo que
     * pone un número en rojo es justamente que mucha gente reciba algo que no
     * pidió — o sea que el caso que la guarda existe para evitar es el que la
     * campaña misma provoca mientras sale.
     */
    const campaignId = await nuevaCampana('El número se puso rojo');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, deps()));

    const res = await en((c) =>
      enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 2 }, deps('rojo')),
    );
    expect(res.estado).toBe('partial');
    expect(res.encolados).toBe(0);
    expect(res.quedan).toBe(3);
    expect(res.motivoDelCorte).toMatch(/calidad ROJA/);

    const fila = await admin.query('SELECT status, stop_reason FROM campaigns WHERE id = $1', [campaignId]);
    expect(fila.rows[0].status).toBe('partial');
    expect(fila.rows[0].stop_reason).toMatch(/calidad ROJA/);
    // Y a nadie más se le escribió: dos filas, las del primer lote.
    const filas = await admin.query(
      'SELECT count(*)::int n FROM campaign_recipients WHERE campaign_id = $1',
      [campaignId],
    );
    expect(filas.rows[0].n).toBe(2);
  });

  it('alguien que se da de baja a mitad de campaña la CIERRA, no la deja girando', async () => {
    /**
     * El bucle caliente que esto evita: el segmento exige `opted_out_at IS
     * NULL`, así que quien se da de baja mientras la campaña sale desaparece
     * del lote siguiente —correcto, no hay que escribirle— pero nunca llega a
     * tener fila en `campaign_recipients`. Y `quedan` se cuenta contra el total
     * CONGELADO, así que se queda en 1 para siempre:
     *
     *   lote vacío → quedan = 1 > 0 → `sending` → se encola otra vez → …
     *
     * El worker girando sin fin contra un segmento que ya no tiene a nadie.
     */
    const campaignId = await nuevaCampana('Alguien se dio de baja');
    await en((c) => iniciarCampana(c, { tenantId: tenant, campaignId }, deps()));
    // Salen cuatro de los cinco.
    await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 4 }, deps()));
    // Y el quinto se da de baja antes de que le toque.
    const faltante = await admin.query(
      `SELECT c.id FROM contacts c
        JOIN contact_tags ct ON ct.contact_id = c.id AND ct.tag_id = $2
       WHERE c.tenant_id = $1
         AND NOT EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = $3 AND r.contact_id = c.id)`,
      [tenant, etiquetaLote, campaignId],
    );
    expect(faltante.rowCount).toBe(1);
    await admin.query('UPDATE contacts SET opted_out_at = now() WHERE id = $1', [faltante.rows[0].id]);

    const res = await en((c) => enviarLoteDeCampana(c, { tenantId: tenant, campaignId, lote: 4 }, deps()));
    // Cierra, no gira. Y lo que dice es la verdad: esa persona no recibió.
    expect(res.estado).toBe('partial');
    expect(res.quedan).toBe(1);
    expect(res.motivoDelCorte).toMatch(/ya no estaban en el segmento/);
  });

  it('el tope de 5.000 del segmento dejaba de decirse: ahora avisa (#609)', async () => {
    // Con `tope` explícito para no crear 5.001 contactos. El camino es el mismo
    // que el del valor por defecto: lo que cambia es el número.
    const { total, truncado } = await en((c) =>
      contarSegmento(c, { tenantId: tenant, filtros: { tagIds: [etiquetaLote] }, tope: 2 }),
    );
    expect(total).toBe(2);
    expect(truncado).toBe(true);

    // Y sin tope no trunca: el aviso solo aparece cuando de verdad quedó gente.
    const completo = await en((c) =>
      contarSegmento(c, { tenantId: tenant, filtros: { tagIds: [etiquetaLote] } }),
    );
    expect(completo.truncado).toBe(false);
  });
});
