import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { accionesParaElPrompt } from '../application/acciones-en-la-conversacion';
import { suggestForInbound } from '../application/copilot';
import { createAgent } from '../application/agents';
import { formatoAutonomo } from '../domain/escalation';
import type { ModelPortFactory } from '../application/models';

/**
 * El modelo sabe qué puede proponer (#1020).
 *
 * «Una de las que te pasaron» del formato de sugerencia no refería a nada:
 * las tools que viajan al modelo son las de LECTURA (#240) y la lista de
 * acciones solo filtraba DESPUÉS. El modelo proponía a ciegas. Acá se cuida
 * que el catálogo viaje en el prompt, filtrado por módulos activos — y que
 * el prompt autónomo distinga la PREGUNTA del cliente del OBJETIVO del
 * agente, que es lo que botaba respuestas buenas (la ejecución medida en
 * #1020: precio y horario respondidos con confianza 0,9, escalados igual).
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let conversacion: string;

const JSON_SUGERENCIA = `{"sugerencia": "¡Hola! Sí, tenemos horas.", "confianza": 0.8,
 "intencion": "agendar", "calificacion": "tibio", "crear_oportunidad": false, "accion": null}`;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name) VALUES ('modelo-sabe-proponer') RETURNING id",
  );
  tenant = t.rows[0].id;
  await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.', actor: 'test' }),
  );
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56961110077',
      channel: 'simulador',
      body: '¿Me pueden agendar para mañana?',
    }),
  );
  conversacion = res.conversation.id;
});

afterAll(async () => {
  for (const tabla of ['suggestions', 'agent_executions', 'agents', 'usage_meters', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('el catálogo de acciones en el prompt (#1020)', () => {
  it('sin módulos declarados ofrece todas las proponibles, con su descripción', () => {
    const bloque = accionesParaElPrompt();
    expect(bloque).not.toBeNull();
    for (const nombre of [
      'agenda.agendar',
      'agenda.mover',
      'agenda.estado',
      'conversations.state',
      'payments.createLink',
      'deals.move',
    ]) {
      expect(bloque).toContain(nombre);
    }
    // No las ejecuta él: el texto lo dice, porque el modelo escribe lo que lee.
    expect(bloque).toContain('visto bueno');
  });

  it('con pagos apagado no ofrece el link de pago, y la agenda sigue', () => {
    const bloque = accionesParaElPrompt(['calendar', 'conversations', 'crm']);
    expect(bloque).toContain('agenda.agendar');
    expect(bloque).not.toContain('payments.createLink');
  });

  it('sin ningún módulo que las sostenga, no hay bloque — null, no texto vacío', () => {
    expect(accionesParaElPrompt([])).toBeNull();
  });
});

describe('el prompt de sugerir lleva el catálogo', () => {
  it('el modelo recibe los nombres exactos que puede proponer', async () => {
    const prompts: string[] = [];
    const espia: ModelPortFactory = () => ({
      async generate(args) {
        prompts.push(args.prompt);
        return { text: JSON_SUGERENCIA, tokensIn: 100, tokensOut: 40 };
      },
    });
    const sug = await withTenant(admin, tenant, (c) =>
      suggestForInbound(
        c,
        { tenantId: tenant, conversationId: conversacion, activeModules: ['calendar', 'conversations'] },
        espia,
      ),
    );
    expect(sug).not.toBeNull();
    const deSugerir = prompts.find((p) => p.includes('"sugerencia"'));
    expect(deSugerir).toBeDefined();
    expect(deSugerir).toContain('agenda.agendar');
    // Pagos no está activo: proponer un link que va a fallar no se ofrece.
    expect(deSugerir).not.toContain('payments.createLink');
    // El esquema de argumentos viaja con cada acción (#1049): sin él, el
    // modelo inventaba «fecha_hora: próximo jueves» y Confirmar fallaba
    // siempre. Y lo del sistema se le pide que NI lo escriba.
    expect(deSugerir).toContain('"inicio"');
    expect(deSugerir).toContain('ISO 8601');
    expect(deSugerir).toContain('no los escribas');
    // El ancla temporal: sin saber qué día es, no hay fechas ISO posibles.
    expect(deSugerir).toContain('Hoy es');
    expect(deSugerir).toContain('America/Santiago');
  });
});

describe('el prompt autónomo distingue la pregunta del objetivo', () => {
  it('dice que no poder gestionar NO es fuera_de_conocimiento, y que no se vuelca el contexto', () => {
    const prompt = formatoAutonomo({ moneyLimitClp: null });
    // La frase que faltaba cuando la ejecución de #1020 botó una respuesta
    // buena: respondió precio y horario con confianza 0,9 y escaló igual,
    // porque su objetivo «agendar» no se podía cumplir.
    expect(prompt).toContain('no de tu objetivo');
    expect(prompt).toContain('NO es "fuera_de_conocimiento"');
    // Y el eco del contexto (#1021): en sus palabras, solo lo preguntado.
    expect(prompt).toContain('sin volcar el contexto entero');
    expect(prompt).toContain('ni ofrecer gestiones que nadie pidió');
  });
});
