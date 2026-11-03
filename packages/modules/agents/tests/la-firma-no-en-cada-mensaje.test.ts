import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound, sendMessage } from '@iaxti/module-conversations';
import { firmaDelAgente, guardrailLimits, leTocaFirma } from '../application/autonomous';
import type { Agent } from '../application/agents';

/**
 * La firma, una vez o en cada mensaje (#1227).
 *
 * Dicho por el dueño: «elimina eso, qué molesto que sean todos los mensajes».
 * Y en una conversación de verdad es cierto: a la cuarta respuesta el pie
 * ocupa un tercio de la pantalla del teléfono repitiendo algo que la persona
 * ya leyó tres veces. Con el pulso del evento (#1210) escribiendo cada 40
 * minutos, es ruido puro.
 *
 * Lo que NO se hace: quitarlo. SPEC §13 lo pide —«cada respuesta autónoma
 * lleva el nombre del asistente y la opción de pedir humano»— y es cómo
 * alguien se entera de que habla con un bot y de que puede salir. El defecto
 * del producto se queda en firmar siempre; un negocio puede elegir otra cosa.
 */
const agenteCon = (limits: Record<string, unknown>) =>
  ({ id: 'a', name: 'IAxTi', limits, active: true } as unknown as Agent);

describe('firma en cada mensaje (#1227)', () => {
  /**
   * `!== false` y no `Boolean(...)`, y esta prueba es la razón: un agente que
   * nunca configuró nada tiene que seguir firmando. Con `Boolean`, todos los
   * agentes que existen hoy habrían dejado de firmar en silencio — el SPEC
   * roto por un defecto de lectura.
   */
  it('sin configurar: firma SIEMPRE, que es el defecto del SPEC', () => {
    expect(guardrailLimits(agenteCon({})).firmaEnCadaMensaje).toBe(true);
    expect(guardrailLimits(agenteCon({ max_agent_turns: 60 })).firmaEnCadaMensaje).toBe(true);
    expect(guardrailLimits(agenteCon({ firma_en_cada_mensaje: true })).firmaEnCadaMensaje).toBe(true);
  });

  it('solo el booleano `false` la deja una vez por conversación', () => {
    expect(guardrailLimits(agenteCon({ firma_en_cada_mensaje: false })).firmaEnCadaMensaje).toBe(false);
  });

  /**
   * Y un valor raro NO apaga la firma. `'no'`, `0` y `null` son lo que llega
   * de un formulario o de un JSON escrito a mano, y ante la duda el producto
   * tiene que caer del lado del SPEC.
   */
  it('un valor que no es `false` tampoco la apaga', () => {
    for (const valor of ['no', 'false', 0, null, undefined, '']) {
      expect(
        guardrailLimits(agenteCon({ firma_en_cada_mensaje: valor })).firmaEnCadaMensaje,
        `con ${JSON.stringify(valor)} tiene que seguir firmando`,
      ).toBe(true);
    }
  });

  it('el pie dice las dos cosas que pide el SPEC: quién escribe y cómo pedir humano', () => {
    const firma = firmaDelAgente(agenteCon({}));
    expect(firma).toContain('IAxTi');
    expect(firma).toContain('asistente virtual');
    expect(firma).toContain('humano');
  });
});

describe('cuándo le toca firma a un mensaje (#1227)', () => {
  let pool: Pool;
  let tenantId: string;
  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('firma-una-vez') RETURNING id")).rows[0].id;
  });
  afterAll(async () => {
    await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
    await pool.end();
  });

  const sinFirmarSiempre = agenteCon({ firma_en_cada_mensaje: false });

  it('con el defecto del SPEC firma aunque ya haya hablado', async () => {
    const conv = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, { tenantId, channel: 'whatsapp', phone: '+56933330001', body: 'hola' }),
    );
    await withTenant(pool, tenantId, (c) =>
      sendMessage(c, {
        tenantId,
        conversationId: conv.conversation.id,
        authorKind: 'agent',
        type: 'texto',
        body: 'ya hablé antes',
      }),
    );
    const toca = await withTenant(pool, tenantId, (c) =>
      leTocaFirma(c, { tenantId, conversationId: conv.conversation.id, agent: agenteCon({}) }),
    );
    expect(toca).toBe(true);
  });

  it('con la firma una vez: la primera sí, la segunda no', async () => {
    const conv = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, { tenantId, channel: 'whatsapp', phone: '+56933330002', body: 'hola' }),
    );
    const primera = await withTenant(pool, tenantId, (c) =>
      leTocaFirma(c, { tenantId, conversationId: conv.conversation.id, agent: sinFirmarSiempre }),
    );
    expect(primera, 'la primera respuesta del agente SÍ firma').toBe(true);
    await withTenant(pool, tenantId, (c) =>
      sendMessage(c, {
        tenantId,
        conversationId: conv.conversation.id,
        authorKind: 'agent',
        type: 'texto',
        body: 'primera respuesta',
      }),
    );
    const segunda = await withTenant(pool, tenantId, (c) =>
      leTocaFirma(c, { tenantId, conversationId: conv.conversation.id, agent: sinFirmarSiempre }),
    );
    expect(segunda, 'la segunda ya no').toBe(false);
  });

  /**
   * Y un mensaje escrito por una PERSONA del equipo no presenta al bot.
   *
   * Por eso la consulta pregunta por `author_kind = 'agent'` y no por «hay
   * algún saliente»: después de que un vendedor contestó a mano, la primera
   * respuesta autónoma sigue siendo la primera que el cliente recibe de un
   * bot, y es la que tiene que decirle que lo es.
   */
  it('lo que escribió una persona no cuenta como presentación del bot', async () => {
    const conv = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, { tenantId, channel: 'whatsapp', phone: '+56933330003', body: 'hola' }),
    );
    await withTenant(pool, tenantId, (c) =>
      sendMessage(c, {
        tenantId,
        conversationId: conv.conversation.id,
        authorKind: 'user',
        type: 'texto',
        body: 'te contesto yo, el vendedor',
      }),
    );
    const toca = await withTenant(pool, tenantId, (c) =>
      leTocaFirma(c, { tenantId, conversationId: conv.conversation.id, agent: sinFirmarSiempre }),
    );
    expect(toca, 'el bot todavía no se presentó: le toca firmar').toBe(true);
  });
});

/**
 * El texto de la firma lo escribe el negocio (#1242).
 *
 * El pie estaba en el código, y en el agente del evento quedaba pegado a una
 * respuesta que dos frases antes ya decía quién era y a quién pasaba: «Pásate
 * por el stand de VoxTi Labs… / IAxTi — asistente virtual. Escribe "humano"…».
 * El requisito de SPEC §13 es que el cliente lo SEPA, y eso se puede cumplir
 * con otras palabras — o con un agente que se presenta.
 */
describe('el texto de la firma (#1242)', () => {
  it('sin configurar: el texto de siempre, carácter por carácter', () => {
    // Escrito a mano y no construido con la misma plantilla que el código: si
    // esta prueba armara el texto igual que `firmaDelAgente`, cambiar la
    // plantilla las movería a las dos y ningún negocio se enteraría.
    expect(firmaDelAgente(agenteCon({}))).toBe(
      'IAxTi — asistente virtual. Escribe "humano" y te paso con una persona.',
    );
  });

  it('con texto propio: ese texto', () => {
    expect(firmaDelAgente(agenteCon({ firma: 'Soy el bot de VoxTi. Pide "humano" y te paso con Lino.' }))).toBe(
      'Soy el bot de VoxTi. Pide "humano" y te paso con Lino.',
    );
  });

  /**
   * La cadena vacía es una DECISIÓN, no un campo sin llenar, y por eso el
   * lector no la recorta ni la descarta. Un `?? ''` o un `.trim() !== ''` en
   * `guardrailLimits` haría caer este caso al defecto, y el dueño vería que
   * guardó «sin firma» y el bot sigue firmando.
   */
  it('vacía: el mensaje sale sin pie', () => {
    expect(firmaDelAgente(agenteCon({ firma: '' }))).toBe('');
    expect(guardrailLimits(agenteCon({ firma: '' })).firma).toBe('');
  });

  it('lo que no es texto no es configuración', () => {
    expect(guardrailLimits(agenteCon({ firma: null })).firma).toBeNull();
    expect(guardrailLimits(agenteCon({ firma: 42 })).firma).toBeNull();
    expect(firmaDelAgente(agenteCon({ firma: 42 }))).toContain('asistente virtual');
  });
});
