// El configurador (#50): plantillas por rubro como BASE, el modelo ajusta
// con la descripción del negocio, y la salida es un DIFF antes/después que
// el usuario aplica. Incremental: lo que ya existe jamás se pisa.

export const VERTICALS = ['belleza', 'salud', 'inmobiliaria', 'retail', 'servicios', 'otro'] as const;
export type Vertical = (typeof VERTICALS)[number];

export interface VerticalBase {
  pipeline: { name: string; stages: Array<{ name: string; type: 'open' | 'won' | 'lost' }> };
  quickReplies: Array<{ shortcut: string; body: string }>;
  waTemplates: Array<{ name: string; body: string }>;
}

const CIERRE = [
  { name: 'Ganado', type: 'won' as const },
  { name: 'Perdido', type: 'lost' as const },
];

/** La base por rubro (SPEC §13): el modelo parte de aquí, no de cero. */
export const VERTICAL_BASES: Record<Vertical, VerticalBase> = {
  belleza: {
    pipeline: {
      name: 'Agenda y ventas',
      stages: [
        { name: 'Consulta', type: 'open' },
        { name: 'Cotizado', type: 'open' },
        { name: 'Agendado', type: 'open' },
        ...CIERRE,
      ],
    },
    quickReplies: [
      { shortcut: 'horas', body: 'Hola {{nombre}}, ¡gracias por escribirnos! ¿Para qué día te acomoda tu hora?' },
      { shortcut: 'precios', body: 'Te dejo nuestra lista de precios actualizada. ¿Cuál servicio te interesa?' },
      { shortcut: 'confirmar', body: 'Hola {{nombre}}, te confirmamos tu hora. ¡Te esperamos! Si no puedes venir, avísanos con anticipación.' },
    ],
    waTemplates: [
      { name: 'recordatorio_hora', body: 'Hola {{1}}, te recordamos tu hora de mañana a las {{2}}. Responde SÍ para confirmar.' },
      { name: 'reactivacion', body: 'Hola {{1}}, ¡te extrañamos! Este mes tenemos novedades. ¿Quieres agendar una hora?' },
      { name: 'agradecimiento', body: 'Gracias por tu visita, {{1}}. ¿Cómo fue tu experiencia? Tu opinión nos ayuda a mejorar.' },
    ],
  },
  salud: {
    pipeline: {
      name: 'Pacientes',
      stages: [
        { name: 'Consulta', type: 'open' },
        { name: 'Presupuestado', type: 'open' },
        { name: 'Agendado', type: 'open' },
        { name: 'En tratamiento', type: 'open' },
        ...CIERRE,
      ],
    },
    quickReplies: [
      { shortcut: 'horas', body: 'Hola {{nombre}}, ¿para qué día necesitas tu hora? Atendemos de lunes a viernes.' },
      { shortcut: 'previsión', body: 'Trabajamos con Fonasa e Isapres. ¿Cuál es tu previsión para indicarte el copago?' },
    ],
    waTemplates: [
      { name: 'recordatorio_cita', body: 'Hola {{1}}, le recordamos su cita del {{2}} a las {{3}}. Responda SÍ para confirmar.' },
      { name: 'resultado_disponible', body: 'Hola {{1}}, sus resultados ya están disponibles. Puede retirarlos o pedirlos por aquí.' },
      { name: 'control', body: 'Hola {{1}}, corresponde su control. ¿Agendamos una hora esta semana?' },
    ],
  },
  inmobiliaria: {
    pipeline: {
      name: 'Corretaje',
      stages: [
        { name: 'Lead', type: 'open' },
        { name: 'Visita agendada', type: 'open' },
        { name: 'Negociación', type: 'open' },
        { name: 'Promesa', type: 'open' },
        ...CIERRE,
      ],
    },
    quickReplies: [
      { shortcut: 'ficha', body: 'Hola {{nombre}}, te envío la ficha de la propiedad. ¿Te gustaría agendar una visita?' },
      { shortcut: 'requisitos', body: 'Para arrendar necesitas: renta 3x el arriendo, contrato vigente y sin DICOM. ¿Cumples con los requisitos?' },
    ],
    waTemplates: [
      { name: 'nueva_propiedad', body: 'Hola {{1}}, llegó una propiedad que calza con lo que buscas: {{2}}. ¿Te envío la ficha?' },
      { name: 'recordatorio_visita', body: 'Hola {{1}}, te recordamos la visita de mañana a las {{2}} en {{3}}. ¿Confirmas?' },
      { name: 'seguimiento', body: 'Hola {{1}}, ¿qué te pareció la propiedad que visitaste? ¿Seguimos buscando o avanzamos con esta?' },
    ],
  },
  retail: {
    pipeline: {
      name: 'Ventas',
      stages: [
        { name: 'Consulta', type: 'open' },
        { name: 'Cotizado', type: 'open' },
        { name: 'Por pagar', type: 'open' },
        { name: 'Despachado', type: 'open' },
        ...CIERRE,
      ],
    },
    quickReplies: [
      { shortcut: 'stock', body: 'Hola {{nombre}}, déjame revisar el stock y te confirmo altiro.' },
      { shortcut: 'despacho', body: 'Hacemos despacho a todo Chile. Santiago 24-48 h, regiones 3-5 días hábiles.' },
      { shortcut: 'pago', body: 'Puedes pagar por transferencia o tarjeta. Te envío el link de pago cuando confirmes.' },
    ],
    waTemplates: [
      { name: 'pedido_despachado', body: 'Hola {{1}}, tu pedido va en camino. Número de seguimiento: {{2}}.' },
      { name: 'carro_pendiente', body: 'Hola {{1}}, quedó pendiente tu compra de {{2}}. ¿La retomamos? El stock vuela.' },
      { name: 'oferta', body: 'Hola {{1}}, tenemos una oferta en {{2}} que te puede interesar. ¿Te cuento más?' },
    ],
  },
  servicios: {
    pipeline: {
      name: 'Proyectos',
      stages: [
        { name: 'Contacto', type: 'open' },
        { name: 'Reunión', type: 'open' },
        { name: 'Propuesta enviada', type: 'open' },
        { name: 'Negociación', type: 'open' },
        ...CIERRE,
      ],
    },
    quickReplies: [
      { shortcut: 'reunion', body: 'Hola {{nombre}}, con gusto te cuento. ¿Tienes 15 minutos esta semana para una llamada?' },
      { shortcut: 'propuesta', body: 'Te envío la propuesta con valores y plazos. Cualquier duda me dices y la vemos juntos.' },
    ],
    waTemplates: [
      { name: 'seguimiento_propuesta', body: 'Hola {{1}}, ¿pudiste revisar la propuesta? Quedo atento a tus comentarios.' },
      { name: 'recordatorio_reunion', body: 'Hola {{1}}, te recuerdo nuestra reunión de mañana a las {{2}}. ¡Nos vemos!' },
      { name: 'cierre_proyecto', body: 'Hola {{1}}, terminamos el proyecto. ¿Agendamos una reunión de cierre y próximos pasos?' },
    ],
  },
  otro: {
    pipeline: {
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'En conversación', type: 'open' },
        { name: 'Cotizado', type: 'open' },
        ...CIERRE,
      ],
    },
    quickReplies: [
      { shortcut: 'hola', body: 'Hola {{nombre}}, ¡gracias por escribirnos! ¿En qué te podemos ayudar?' },
      { shortcut: 'precios', body: 'Te cuento nuestros precios. ¿Qué producto o servicio te interesa?' },
    ],
    waTemplates: [
      { name: 'seguimiento', body: 'Hola {{1}}, ¿sigues interesado en {{2}}? Quedo atento para ayudarte.' },
      { name: 'agradecimiento', body: 'Gracias por preferirnos, {{1}}. ¿Cómo fue tu experiencia con nosotros?' },
      { name: 'novedades', body: 'Hola {{1}}, tenemos novedades que te pueden interesar. ¿Te cuento?' },
    ],
  },
};

/** El formato que se le pide al configurador (task `configurar`, gama alta). */
export function formatoConfiguracion(base: VerticalBase): string {
  return `Eres el configurador de un CRM chileno para pymes. A partir de la descripción del negocio,
AJUSTA esta base del rubro (renombra etapas, agrega o quita, adapta los textos al negocio concreto,
tutea con cercanía chilena). Mantén máximo 6 etapas abiertas, 3-5 respuestas rápidas y EXACTAMENTE
las 3 plantillas de WhatsApp más útiles para ESTE negocio.

BASE DEL RUBRO:
${JSON.stringify(base, null, 2)}

Responde SOLO este JSON (misma estructura):
{"pipeline": {"name": "...", "stages": [{"name": "...", "type": "open|won|lost"}]},
 "quickReplies": [{"shortcut": "...", "body": "..."}],
 "waTemplates": [{"name": "...", "body": "..."}],
 "nota": "<una frase para el dueño explicando qué adaptaste y por qué>"}`;
}

export interface ConfigProposal {
  pipeline: { name: string; stages: Array<{ name: string; type: 'open' | 'won' | 'lost' }> };
  quickReplies: Array<{ shortcut: string; body: string }>;
  waTemplates: Array<{ name: string; body: string }>;
  nota: string | null;
}

/** Parser defensivo: basura → null (el configurador no adivina). */
export function parseConfiguration(raw: string): ConfigProposal | null {
  const inicio = raw.indexOf('{');
  const fin = raw.lastIndexOf('}');
  if (inicio === -1 || fin <= inicio) return null;
  try {
    const obj = JSON.parse(raw.slice(inicio, fin + 1)) as Record<string, unknown>;
    const pipeline = obj.pipeline as ConfigProposal['pipeline'] | undefined;
    if (!pipeline?.name || !Array.isArray(pipeline.stages) || pipeline.stages.length === 0) return null;
    const stages = pipeline.stages
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({ name: s.name.trim(), type: s.type === 'won' || s.type === 'lost' ? s.type : ('open' as const) }));
    if (!stages.some((s) => s.type === 'won') || !stages.some((s) => s.type === 'lost')) {
      stages.push(...CIERRE.filter((c) => !stages.some((s) => s.type === c.type)));
    }
    const lista = <T>(v: unknown, valida: (x: T) => boolean): T[] =>
      Array.isArray(v) ? (v as T[]).filter(valida) : [];
    return {
      pipeline: { name: pipeline.name.trim(), stages },
      quickReplies: lista<{ shortcut: string; body: string }>(
        obj.quickReplies,
        (q) => typeof q?.shortcut === 'string' && typeof q?.body === 'string',
      ).map((q) => ({ shortcut: q.shortcut.trim().toLowerCase().replace(/^\//, ''), body: q.body.trim() })),
      waTemplates: lista<{ name: string; body: string }>(
        obj.waTemplates,
        (t) => typeof t?.name === 'string' && typeof t?.body === 'string',
      ).slice(0, 3),
      nota: typeof obj.nota === 'string' ? obj.nota : null,
    };
  } catch {
    return null;
  }
}

export interface ConfigSnapshot {
  pipelines: Array<{ name: string; stages: string[] }>;
  quickReplies: string[]; // atajos existentes
  whatsappActivo: boolean;
}

export interface ConfigDiffItem {
  tipo: 'pipeline' | 'quick_reply' | 'wa_template';
  nombre: string;
  detalle: string;
  accion: 'crear' | 'ya_existe' | 'proponer';
}

export interface ConfigDiff {
  antes: { pipelines: string[]; quickReplies: string[] };
  items: ConfigDiffItem[];
  nota: string | null;
}

/**
 * El diff antes/después (dispositivo Pulso): qué hay HOY y qué propone el
 * configurador. Incremental por diseño — lo que ya existe con el mismo
 * nombre queda `ya_existe` y aplicar NUNCA lo toca (re-ejecutable, #50).
 */
export function buildDiff(snapshot: ConfigSnapshot, propuesta: ConfigProposal): ConfigDiff {
  const items: ConfigDiffItem[] = [];
  const pipeYaExiste = snapshot.pipelines.some(
    (p) => p.name.toLowerCase() === propuesta.pipeline.name.toLowerCase(),
  );
  items.push({
    tipo: 'pipeline',
    nombre: propuesta.pipeline.name,
    detalle: propuesta.pipeline.stages.map((s) => s.name).join(' → '),
    accion: pipeYaExiste ? 'ya_existe' : 'crear',
  });
  for (const q of propuesta.quickReplies) {
    items.push({
      tipo: 'quick_reply',
      nombre: `/${q.shortcut}`,
      detalle: q.body,
      accion: snapshot.quickReplies.includes(q.shortcut) ? 'ya_existe' : 'crear',
    });
  }
  for (const t of propuesta.waTemplates) {
    items.push({
      tipo: 'wa_template',
      nombre: t.name,
      detalle: t.body,
      // Las plantillas van a APROBACIÓN de Meta cuando el canal está
      // activo (#44); mientras tanto quedan propuestas en el diff.
      accion: 'proponer',
    });
  }
  return {
    antes: {
      pipelines: snapshot.pipelines.map((p) => `${p.name}: ${p.stages.join(' → ')}`),
      quickReplies: snapshot.quickReplies.map((s) => `/${s}`),
    },
    items,
    nota: propuesta.nota,
  };
}
