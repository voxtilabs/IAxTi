import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import {
  createContact,
  createDeal,
  createPipeline,
  createTag,
  ensureDefaultLossReasons,
  listLossReasons,
  moveDealStage,
} from '@iaxti/module-crm';
import {
  assignConversation,
  changeConversationState,
  createQuickReply,
  receiveInbound,
  sendMessage,
} from '@iaxti/module-conversations';
import { agendar, cambiarEstadoCita } from '@iaxti/module-calendar';
import { createAgent } from '@iaxti/module-agents';

/**
 * El negocio de demostración, con cosas adentro (#432).
 *
 * El seed dejaba el tenant con dos usuarios y nada más, así que el producto
 * se veía entero en estado vacío: doce pantallas explicando qué va a
 * aparecer algún día. Los estados vacíos están bien hechos —esa parte no se
 * toca, porque un negocio recién creado SÍ se ve así— y por eso el remedio
 * es este tenant y no ellos.
 *
 * Tres reglas que se respetan acá:
 *
 *  1. **Se crea por las funciones del producto**, no con INSERT a mano.
 *     Un contacto sembrado a mano se salta la normalización del teléfono,
 *     el evento y la auditoría, y entonces la demo prueba algo que el
 *     producto no hace. Lo único que se escribe directo son las FECHAS
 *     —mover una fila al pasado— y el agregado diario.
 *  2. **Idempotente**: se reconoce por el teléfono de cada contacto. Correr
 *     el seed dos veces no duplica ni una fila.
 *  3. **Nada real**: nombres inventados y teléfonos de un rango que no se
 *     asigna a personas. Si algún día esto corre contra una base con datos
 *     de verdad, no le escribe a nadie — nada de esto sale hacia afuera:
 *     los mensajes se escriben como ya entregados.
 */

/** Un azar reproducible: el mismo seed dos veces da el mismo negocio. */
function azar(semilla: number): () => number {
  let s = semilla;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const HOY = () => new Date();
const diasAtras = (n: number, hora = 10): Date => {
  const d = new Date(HOY().getTime() - n * 86_400_000);
  d.setUTCHours(hora, 0, 0, 0);
  return d;
};

/**
 * Teléfonos +56 9 9900 00xx: el rango 99 no está asignado a personas en
 * Chile. Si alguien mira la demo y marca uno, no llama a nadie.
 */
const PERSONAS = [
  { nombre: 'Camila Fuentes', telefono: '+56999000001' },
  { nombre: 'Matías Rojas', telefono: '+56999000002' },
  { nombre: 'Valentina Soto', telefono: '+56999000003' },
  { nombre: 'Ignacio Muñoz', telefono: '+56999000004' },
  { nombre: 'Josefa Contreras', telefono: '+56999000005' },
  { nombre: 'Tomás Vergara', telefono: '+56999000006' },
  { nombre: 'Antonia Herrera', telefono: '+56999000007' },
  { nombre: 'Benjamín Castro', telefono: '+56999000008' },
  { nombre: 'Florencia Díaz', telefono: '+56999000009' },
  { nombre: 'Sebastián Núñez', telefono: '+56999000010' },
  { nombre: 'Isidora Pizarro', telefono: '+56999000011' },
  { nombre: 'Lucas Morales', telefono: '+56999000012' },
] as const;

/** Conversaciones de verdad: lo que una peluquería recibe un martes. */
const HILOS: Array<{
  persona: number;
  diasAtras: number;
  estado: 'sin_atender' | 'atendida' | 'resuelta' | 'fuera_de_ventana';
  mensajes: Array<{ de: 'cliente' | 'negocio'; texto: string }>;
}> = [
  {
    persona: 0,
    diasAtras: 0,
    estado: 'sin_atender',
    mensajes: [{ de: 'cliente', texto: 'Hola! Tienen hora para mañana en la tarde?' }],
  },
  {
    persona: 1,
    diasAtras: 0,
    estado: 'sin_atender',
    mensajes: [
      { de: 'cliente', texto: 'Buenas, cuánto sale el corte con barba?' },
      { de: 'cliente', texto: 'Y atienden los sábados?' },
    ],
  },
  {
    persona: 2,
    diasAtras: 0,
    estado: 'sin_atender',
    mensajes: [{ de: 'cliente', texto: 'Quiero cambiar mi hora del jueves, se puede?' }],
  },
  {
    persona: 3,
    diasAtras: 1,
    estado: 'atendida',
    mensajes: [
      { de: 'cliente', texto: 'Hola, quedan cupos para color esta semana?' },
      { de: 'negocio', texto: 'Hola Ignacio! Sí, nos queda el jueves a las 16:00 y el viernes a las 11:30.' },
      { de: 'cliente', texto: 'El viernes me sirve' },
    ],
  },
  {
    persona: 4,
    diasAtras: 1,
    estado: 'atendida',
    mensajes: [
      { de: 'cliente', texto: 'Buenas! El tratamiento de keratina incluye lavado?' },
      { de: 'negocio', texto: 'Hola Josefa, sí: incluye lavado, tratamiento y sellado. Son 90 minutos.' },
    ],
  },
  {
    persona: 5,
    diasAtras: 2,
    estado: 'atendida',
    mensajes: [
      { de: 'cliente', texto: 'Se puede pagar con transferencia?' },
      { de: 'negocio', texto: 'Claro que sí, Tomás. Te paso los datos cuando confirmes tu hora.' },
    ],
  },
  {
    persona: 6,
    diasAtras: 3,
    estado: 'resuelta',
    mensajes: [
      { de: 'cliente', texto: 'Hola, a qué hora abren hoy?' },
      { de: 'negocio', texto: 'Hola Antonia! Hoy abrimos de 10:00 a 20:00.' },
      { de: 'cliente', texto: 'Perfecto, gracias!' },
    ],
  },
  {
    persona: 7,
    diasAtras: 4,
    estado: 'resuelta',
    mensajes: [
      { de: 'cliente', texto: 'Quedé muy contento con el corte, gracias!' },
      { de: 'negocio', texto: 'Qué bueno, Benjamín. Te esperamos la próxima!' },
    ],
  },
  {
    persona: 8,
    diasAtras: 5,
    estado: 'resuelta',
    mensajes: [
      { de: 'cliente', texto: 'Hola, hacen peinados para matrimonio?' },
      { de: 'negocio', texto: 'Sí! Hacemos peinado y maquillaje. ¿Para qué fecha sería?' },
      { de: 'cliente', texto: 'Para el 12 del próximo mes' },
      { de: 'negocio', texto: 'Perfecto, te dejo agendada una visita previa para probar el peinado.' },
    ],
  },
  {
    // La que enseña la ventana de 24 h: hace cuatro días que no escribe, así
    // que por WhatsApp ya no se le puede responder sin plantilla.
    persona: 9,
    diasAtras: 4,
    estado: 'fuera_de_ventana',
    mensajes: [
      { de: 'cliente', texto: 'Después te confirmo, gracias' },
    ],
  },
];

export interface ResultadoDemo {
  contactos: number;
  conversaciones: number;
  oportunidades: number;
  citas: number;
  diasDeMetricas: number;
  yaEstaba: boolean;
}

export async function sembrarDemo(
  pool: Pool,
  input: { tenantId: string; duenaId: string; vendedorId: string },
): Promise<ResultadoDemo> {
  const { tenantId, duenaId, vendedorId } = input;

  // Idempotencia por el primer teléfono: si ese contacto está, el negocio
  // ya se sembró. Es la misma idea que `ensureTenant`, una fila más abajo.
  const yaEstaba = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query('SELECT 1 FROM contacts WHERE tenant_id = $1 AND phone = $2', [
      tenantId,
      PERSONAS[0].telefono,
    ]);
    return (r.rowCount ?? 0) > 0;
  });
  if (yaEstaba) {
    return { contactos: 0, conversaciones: 0, oportunidades: 0, citas: 0, diasDeMetricas: 0, yaEstaba: true };
  }

  return withTenant(pool, tenantId, async (c) => {
    // — Lo que el negocio configuró —
    const cuenta = await c.query(
      `INSERT INTO channel_accounts (tenant_id, kind, name, state)
       VALUES ($1, 'simulador', 'Número de demostración', 'active') RETURNING id`,
      [tenantId],
    );
    const channelAccountId = cuenta.rows[0].id as string;

    for (const [shortcut, body] of [
      ['precios', 'Corte $12.000 · Corte + barba $16.000 · Color desde $28.000.'],
      ['horario', 'Atendemos de lunes a sábado, de 10:00 a 20:00.'],
      ['ubicacion', 'Estamos en Av. Irarrázaval 3420, Ñuñoa. A dos cuadras del metro.'],
      ['transferencia', 'Te dejo los datos: Peluquería Demo, RUT 76.543.210-K, Cuenta Vista 000123456.'],
    ] as const) {
      await createQuickReply(c, { tenantId, shortcut, body });
    }
    for (const [name, role] of [
      ['Cliente frecuente', 'good'],
      ['Primera visita', 'info'],
      ['Reclamo', 'bad'],
    ] as const) {
      await createTag(c, { tenantId, name, role });
    }

    const { pipeline, stages } = await createPipeline(c, {
      tenantId,
      name: 'Ventas',
      vertical: 'belleza',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Contactado', type: 'open' },
        { name: 'Agendado', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    });

    await createAgent(c, {
      tenantId,
      name: 'Sofía',
      objetivo: 'agendar',
      objetivoDetalle: 'una hora en el salón',
      fallbackSystemPrompt:
        'Eres Sofía, del salón. Hablas como chilena, breve y cálida. Nunca prometes una hora que no confirmaste.',
      actor: 'seed',
    });

    // — Las personas —
    const contactos: string[] = [];
    for (const [i, p] of PERSONAS.entries()) {
      const contacto = await createContact(c, {
        tenantId,
        phone: p.telefono,
        name: p.nombre,
        // Repartidos: la bandeja se ve distinta según quién mire.
        ownerId: i % 3 === 0 ? duenaId : i % 3 === 1 ? vendedorId : undefined,
        origin: 'whatsapp',
        actor: 'seed',
      });
      contactos.push(contacto.id);
    }

    // — Las conversaciones —
    let conversaciones = 0;
    for (const hilo of HILOS) {
      const primero = hilo.mensajes[0];
      const entrada = await receiveInbound(c, {
        tenantId,
        phone: PERSONAS[hilo.persona].telefono,
        channel: 'simulador',
        channelAccountId,
        body: primero.texto,
      });
      conversaciones += 1;
      for (const m of hilo.mensajes.slice(1)) {
        if (m.de === 'cliente') {
          await receiveInbound(c, {
            tenantId,
            phone: PERSONAS[hilo.persona].telefono,
            channel: 'simulador',
            channelAccountId,
            body: m.texto,
          });
        } else {
          // `system` y no una persona: el seed no suplanta a nadie del
          // equipo, y el mensaje queda como ya entregado (el simulador se
          // entrega dentro de la app).
          await sendMessage(c, {
            tenantId,
            conversationId: entrada.conversation.id,
            authorKind: 'system',
            type: 'texto',
            body: m.texto,
          });
        }
      }
      if (hilo.estado === 'atendida' || hilo.estado === 'resuelta') {
        await assignConversation(c, {
          tenantId,
          conversationId: entrada.conversation.id,
          toOwnerId: hilo.persona % 2 === 0 ? duenaId : vendedorId,
          actor: 'seed',
        });
      }
      if (hilo.estado === 'resuelta') {
        await changeConversationState(c, {
          tenantId,
          conversationId: entrada.conversation.id,
          state: 'resolved',
          actor: 'seed',
        });
      }
      // Las fechas, que es lo único que se escribe a mano: las funciones del
      // producto ponen `now()` y una bandeja donde todo llegó hace diez
      // segundos no se parece a ninguna bandeja real.
      const cuando = diasAtras(hilo.diasAtras, 9 + (hilo.persona % 8));
      await c.query(
        `UPDATE conversations SET created_at = $2, last_message_at = $2, last_inbound_at = $2
          WHERE tenant_id = $1 AND id = $3`,
        [tenantId, cuando, entrada.conversation.id],
      );
      await c.query(
        `UPDATE messages SET created_at = $2 WHERE tenant_id = $1 AND conversation_id = $3`,
        [tenantId, cuando, entrada.conversation.id],
      );
    }

    // — Las oportunidades —
    const abierta = stages.find((s) => s.type === 'open')!;
    const agendado = stages.find((s) => s.name === 'Agendado')!;
    const ganado = stages.find((s) => s.type === 'won')!;
    const perdido = stages.find((s) => s.type === 'lost')!;
    const r = azar(20260921);
    // Los motivos de pérdida hay que crearlos: `listLossReasons` solo lee, y
    // cerrar en perdida sin motivo lo rechaza el dominio (SPEC §10).
    await ensureDefaultLossReasons(c, tenantId);
    const motivos = await listLossReasons(c, tenantId);
    const motivoPerdida = motivos[0]?.id;
    const NEGOCIOS: Array<{ persona: number; titulo: string; valor: number; etapa: 'abierta' | 'agendado' | 'ganado' | 'perdido' }> = [
      { persona: 0, titulo: 'Corte + barba', valor: 16000, etapa: 'abierta' },
      { persona: 1, titulo: 'Color completo', valor: 38000, etapa: 'abierta' },
      { persona: 3, titulo: 'Color y tratamiento', valor: 52000, etapa: 'agendado' },
      { persona: 4, titulo: 'Keratina', valor: 65000, etapa: 'agendado' },
      { persona: 8, titulo: 'Peinado y maquillaje de novia', valor: 145000, etapa: 'agendado' },
      { persona: 6, titulo: 'Corte escolar', valor: 9000, etapa: 'ganado' },
      { persona: 7, titulo: 'Corte + barba', valor: 16000, etapa: 'ganado' },
      { persona: 9, titulo: 'Mechas', valor: 45000, etapa: 'perdido' },
    ];
    let oportunidades = 0;
    for (const n of NEGOCIOS) {
      const deal = await createDeal(c, {
        tenantId,
        contactId: contactos[n.persona],
        pipelineId: pipeline.id,
        title: n.titulo,
        value: n.valor,
        ownerId: n.persona % 2 === 0 ? duenaId : vendedorId,
        actor: 'seed',
      });
      oportunidades += 1;
      const destino =
        n.etapa === 'agendado' ? agendado : n.etapa === 'ganado' ? ganado : n.etapa === 'perdido' ? perdido : null;
      if (destino && destino.id !== abierta.id) {
        await moveDealStage(c, {
          tenantId,
          dealId: deal.id,
          stageId: destino.id,
          // Cerrar en perdido exige el motivo (SPEC §10): "se perdió" sin
          // por qué no le sirve a nadie el día que se revisa el embudo.
          ...(n.etapa === 'perdido' ? { lostReasonId: motivoPerdida } : {}),
          actor: 'seed',
        });
      }
      const nacio = diasAtras(Math.floor(r() * 25) + 2, 12);
      await c.query('UPDATE deals SET created_at = $2 WHERE tenant_id = $1 AND id = $3', [
        tenantId,
        nacio,
        deal.id,
      ]);
    }

    // — Las citas —
    let citas = 0;
    const AGENDA: Array<{ persona: number; dias: number; hora: number; estado?: 'attended' | 'no_show' }> = [
      { persona: 6, dias: -6, hora: 15, estado: 'attended' },
      { persona: 9, dias: -3, hora: 17, estado: 'no_show' },
      { persona: 3, dias: 1, hora: 16 },
      { persona: 4, dias: 2, hora: 11 },
      { persona: 8, dias: 9, hora: 10 },
    ];
    for (const a of AGENDA) {
      const inicio = diasAtras(-a.dias, a.hora);
      const cita = await agendar(c, {
        tenantId,
        contactId: contactos[a.persona],
        ownerId: a.persona % 2 === 0 ? duenaId : vendedorId,
        inicio,
        fin: new Date(inicio.getTime() + 45 * 60_000),
        title: `Hora de ${PERSONAS[a.persona].nombre.split(' ')[0]}`,
        confirmada: true,
        actor: 'seed',
      });
      citas += 1;
      if (a.estado) {
        await cambiarEstadoCita(c, { tenantId, appointmentId: cita.id, to: a.estado, actor: 'seed' });
      }
    }

    // — Los números —
    const diasDeMetricas = await sembrarMetricas(c, tenantId);

    return {
      contactos: contactos.length,
      conversaciones,
      oportunidades,
      citas,
      diasDeMetricas,
      yaEstaba: false,
    };
  });
}

/**
 * Noventa días de agregado diario.
 *
 * Los últimos siete cuadran EXACTO con las conversaciones que existen: si
 * el tablero dice tres el martes, en la bandeja hay tres de ese martes. Más
 * atrás son solo agregados, sin hilo que abrir — que es también lo que pasa
 * en un negocio de verdad cuando la retención ya purgó los mensajes
 * (ADR-0012). Un tablero que promete noventa días de conversaciones que no
 * existen sería peor que uno con menos historia.
 */
async function sembrarMetricas(client: PoolClient, tenantId: string): Promise<number> {
  const TOTAL_OWNER = '00000000-0000-0000-0000-000000000000';
  const r = azar(424242);
  const DIAS = 90;

  // Lo que de verdad hay, por día, en los últimos siete.
  // Por DÍA y no por timestamp: el agregado es diario, así que el borde
  // también. Con `now() - interval '7 days'` el día más antiguo entraba a
  // medias —las conversaciones de esa mañana quedaban fuera— y el tablero
  // decía cinco donde la bandeja tenía cero.
  const reales = await client.query(
    `SELECT created_at::date::text AS dia, count(*)::int AS n
       FROM conversations
      WHERE tenant_id = $1 AND created_at::date > now()::date - 7
      GROUP BY 1`,
    [tenantId],
  );
  const porDiaReal = new Map<string, number>(reales.rows.map((f) => [f.dia as string, f.n as number]));

  for (let i = DIAS - 1; i >= 0; i--) {
    const dia = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const finDeSemana = [0, 6].includes(new Date(`${dia}T12:00:00Z`).getUTCDay());
    const base = finDeSemana ? 2 : 6;
    // Los últimos siete días son los REALES, incluso cuando el número real
    // es cero: un día sin conversaciones que el tablero cuenta como cinco es
    // exactamente la incoherencia que esto viene a evitar. De ahí para atrás
    // es invención declarada — agregado sin hilo que abrir.
    const enLaVentanaReal = i <= 6;
    const conversaciones = enLaVentanaReal
      ? (porDiaReal.get(dia) ?? 0)
      : Math.max(0, Math.round(base + r() * 6 - 2));
    if (conversaciones === 0) continue;
    const resueltas = Math.round(conversaciones * (0.6 + r() * 0.3));
    const oportunidades = Math.round(conversaciones * (0.2 + r() * 0.2));
    const ganadas = Math.round(oportunidades * (0.3 + r() * 0.2));

    for (const [metric, value] of [
      ['conversaciones_nuevas', conversaciones],
      ['resueltas', resueltas],
      ['oportunidades_creadas', oportunidades],
      ['ganadas', ganadas],
      ['perdidas', Math.max(0, Math.round(oportunidades * 0.15))],
      ['valor_ganado_clp', ganadas * (12000 + Math.round(r() * 40000))],
      ['mensajes_enviados', conversaciones * (2 + Math.round(r() * 3))],
      ['ia_ejecuciones', Math.round(conversaciones * 0.8)],
    ] as const) {
      if (value <= 0) continue;
      await client.query(
        `INSERT INTO daily_metrics (tenant_id, day, metric, owner_id, value)
         VALUES ($1, $2::date, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [tenantId, dia, metric, TOTAL_OWNER, value],
      );
    }
  }
  return DIAS;
}
