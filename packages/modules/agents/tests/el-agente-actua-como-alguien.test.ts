import { describe, expect, it } from 'vitest';
import { guardrailLimits } from '../application/autonomous';
import type { Agent } from '../application/agents';

/**
 * Con la identidad de quién trabaja el agente (#1235).
 *
 * El CRM quedaba vacío mientras el bot atendía bien: cinco conversaciones,
 * cinco contactos, cero oportunidades. La causa no era el modelo — en autónomo
 * corría SIN herramientas, porque viajan con la identidad del dueño de la
 * conversación y una conversación autónoma no tiene dueño.
 *
 * Lo que esta llave agrega NO es un modo sin permisos: es una persona real del
 * equipo cuyos permisos el agente usa. Y lo que esta prueba cuida es lo único
 * que podría salir caro: que la llave no se convierta en una forma de actuar a
 * nombre de cualquiera.
 */
const agenteCon = (limits: Record<string, unknown>) =>
  ({ id: 'a', name: 'IAxTi', limits, active: true } as unknown as Agent);

describe('la identidad configurada del agente (#1235)', () => {
  it('sin configurar es null, y entonces nada cambia', () => {
    expect(guardrailLimits(agenteCon({})).actuaComoUserId).toBeNull();
    expect(guardrailLimits(agenteCon({ max_agent_turns: 60 })).actuaComoUserId).toBeNull();
  });

  /**
   * Una cadena vacía o con espacios es `null`, no una identidad.
   *
   * Es lo que deja un formulario cuando alguien borra el campo. Con un `''`
   * tratado como identidad, `roleOf` buscaría el rol de la cadena vacía: no lo
   * encontraría y daría cero permisos, así que el daño sería silencioso —el
   * agente sin herramientas y el dueño creyendo que lo configuró—.
   */
  it('vacío o con espacios NO es una identidad', () => {
    expect(guardrailLimits(agenteCon({ actua_como_user_id: '' })).actuaComoUserId).toBeNull();
    expect(guardrailLimits(agenteCon({ actua_como_user_id: '   ' })).actuaComoUserId).toBeNull();
    expect(guardrailLimits(agenteCon({ actua_como_user_id: null })).actuaComoUserId).toBeNull();
    expect(guardrailLimits(agenteCon({ actua_como_user_id: 42 })).actuaComoUserId).toBeNull();
  });

  it('con un id, lo devuelve sin espacios alrededor', () => {
    expect(guardrailLimits(agenteCon({ actua_como_user_id: '  u-123  ' })).actuaComoUserId).toBe('u-123');
  });
});
