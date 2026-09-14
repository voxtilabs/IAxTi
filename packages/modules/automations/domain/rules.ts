// El dominio del motor (#62, SPEC §15): disparador + condiciones +
// acciones, todo declarativo — evaluable sin tocar la base.

export type TriggerEvent =
  | 'conversation.created'
  | 'conversation.state_changed'
  | 'conversation.assigned'
  | 'deal.created'
  | 'deal.stage_changed'
  | 'agent.escalated';

export const TRIGGER_EVENTS: TriggerEvent[] = [
  'conversation.created',
  'conversation.state_changed',
  'conversation.assigned',
  'deal.created',
  'deal.stage_changed',
  'agent.escalated',
];

export type TimeBase = 'in_stage' | 'no_reply';

export type Trigger =
  | { kind: 'event'; event: TriggerEvent }
  | { kind: 'time'; time: { base: TimeBase; hours: number; stageName?: string } };

export interface Condition {
  field: string; // channel | state | stage | valueClp | optedOut | ownerId | reason …
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'contains' | 'in' | 'empty' | 'not_empty';
  value?: unknown;
}

export type ActionKind = 'add_note' | 'assign' | 'send_message' | 'create_activity' | 'move_stage';

export interface Action {
  kind: ActionKind;
  params: Record<string, unknown>; // body, toOwnerId, title, dueHours, stageName…
}

export interface RuleShape {
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
}

/** Qué módulo necesita cada acción: si está apagado, la regla se PAUSA
 *  con aviso — no falla en silencio (SPEC §15). */
export const ACTION_REQUIREMENTS: Record<ActionKind, string> = {
  add_note: 'conversations',
  assign: 'conversations',
  send_message: 'conversations',
  create_activity: 'crm',
  move_stage: 'crm',
};

export function ruleModuleGaps(actions: Action[], activeModules: string[]): string[] {
  const faltan = new Set<string>();
  for (const accion of actions) {
    const requerido = ACTION_REQUIREMENTS[accion.kind];
    if (requerido && !activeModules.includes(requerido)) faltan.add(requerido);
  }
  return [...faltan];
}

/** Evalúa condiciones sobre el objeto plano. Campo ausente = no cumple. */
export function evaluateConditions(objeto: Record<string, unknown>, conditions: Condition[]): boolean {
  return conditions.every((c) => {
    const valor = objeto[c.field];
    switch (c.op) {
      case 'eq':
        return String(valor ?? '') === String(c.value ?? '');
      case 'ne':
        return String(valor ?? '') !== String(c.value ?? '');
      case 'gt':
        return Number(valor) > Number(c.value);
      case 'lt':
        return Number(valor) < Number(c.value);
      case 'contains':
        return String(valor ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
      case 'in':
        return Array.isArray(c.value) && (c.value as unknown[]).map(String).includes(String(valor ?? ''));
      case 'empty':
        return valor === null || valor === undefined || valor === '';
      case 'not_empty':
        return !(valor === null || valor === undefined || valor === '');
      default:
        return false;
    }
  });
}

export function validateRule(shape: RuleShape): void {
  if (shape.trigger.kind === 'event') {
    if (!TRIGGER_EVENTS.includes(shape.trigger.event)) {
      throw new Error(`El disparador no está en el catálogo: ${shape.trigger.event}.`);
    }
  } else if (shape.trigger.kind === 'time') {
    if (!['in_stage', 'no_reply'].includes(shape.trigger.time?.base)) {
      throw new Error('El disparador de tiempo es "in_stage" o "no_reply".');
    }
    if (!(Number(shape.trigger.time.hours) > 0)) {
      throw new Error('El disparador de tiempo necesita horas mayores a cero.');
    }
  } else {
    throw new Error('El disparador es por evento o por tiempo.');
  }
  if (!Array.isArray(shape.actions) || shape.actions.length === 0) {
    throw new Error('La regla necesita al menos una acción.');
  }
  for (const a of shape.actions) {
    if (!ACTION_REQUIREMENTS[a.kind]) throw new Error(`Acción desconocida: ${a.kind}.`);
    if (a.kind === 'send_message' && !String(a.params?.body ?? '').trim()) {
      throw new Error('El mensaje de la acción no puede ir vacío.');
    }
  }
}

export interface RuleTemplate {
  name: string;
  shape: RuleShape;
  descripcion: string;
}

const SEGUIMIENTO_24H = (msg: string): RuleTemplate => ({
  name: 'Sin respuesta hace 24 horas',
  descripcion: 'El cliente escribió y nadie respondió en un día: tarea + nota para no perderlo.',
  shape: {
    trigger: { kind: 'time', time: { base: 'no_reply', hours: 24 } },
    conditions: [{ field: 'state', op: 'in', value: ['new', 'open'] }],
    actions: [
      { kind: 'add_note', params: { body: msg } },
      { kind: 'create_activity', params: { type: 'llamada', title: 'Retomar conversación sin respuesta', dueHours: 4 } },
    ],
  },
});

const ETAPA_ESTANCADA = (stageName: string): RuleTemplate => ({
  name: `2 días estancado en ${stageName}`,
  descripcion: `Una oportunidad lleva 2 días en ${stageName} sin moverse: tarea de seguimiento.`,
  shape: {
    trigger: { kind: 'time', time: { base: 'in_stage', hours: 48, stageName } },
    conditions: [],
    actions: [
      { kind: 'create_activity', params: { type: 'llamada', title: `Seguimiento: lleva 2 días en ${stageName}`, dueHours: 8 } },
    ],
  },
});

const ESCALAMIENTO_NOTA: RuleTemplate = {
  name: 'La IA escaló: dejar registro',
  descripcion: 'Cuando el copiloto suelta el control, queda nota interna con el motivo para quien tome.',
  shape: {
    trigger: { kind: 'event', event: 'agent.escalated' },
    conditions: [],
    actions: [{ kind: 'add_note', params: { body: 'La IA escaló esta conversación: revisar el motivo en la ficha y responder pronto.' } }],
  },
};

/** Las tres reglas iniciales POR VERTICAL (SPEC §15), listas para activar. */
export const RULE_TEMPLATES: Record<string, RuleTemplate[]> = {
  belleza: [SEGUIMIENTO_24H('Cliente sin respuesta: ofrecerle la próxima hora disponible.'), ETAPA_ESTANCADA('Cotizado'), ESCALAMIENTO_NOTA],
  salud: [SEGUIMIENTO_24H('Paciente sin respuesta: confirmar si aún necesita la hora.'), ETAPA_ESTANCADA('Presupuestado'), ESCALAMIENTO_NOTA],
  inmobiliaria: [SEGUIMIENTO_24H('Lead sin respuesta: retomar con la ficha de la propiedad.'), ETAPA_ESTANCADA('Visita agendada'), ESCALAMIENTO_NOTA],
  retail: [SEGUIMIENTO_24H('Cliente sin respuesta: confirmar stock y cerrar la venta.'), ETAPA_ESTANCADA('Por pagar'), ESCALAMIENTO_NOTA],
  servicios: [SEGUIMIENTO_24H('Cliente sin respuesta: preguntar si revisó la propuesta.'), ETAPA_ESTANCADA('Propuesta enviada'), ESCALAMIENTO_NOTA],
  otro: [SEGUIMIENTO_24H('Cliente sin respuesta: retomar la conversación.'), ETAPA_ESTANCADA('Cotizado'), ESCALAMIENTO_NOTA],
};
