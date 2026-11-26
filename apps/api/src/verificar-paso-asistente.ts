import type { PoolClient } from 'pg';
import { listAgents } from '@iaxti/module-agents';
import type { Verificador } from '@iaxti/module-organizations';

/**
 * El verificador del paso «Crea tu asistente» (#1400), el único lo bastante
 * palabra-y-rama como para no duplicarlo.
 *
 * Lo usan las DOS pantallas que arman el onboarding — `GET /onboarding` y el
 * diagnóstico «¿qué me falta?» del Agente General — y hasta hoy cada una
 * escribía el paso a su modo, con la deuda anotada en el controlador: «la que
 * se queda vieja es siempre la segunda». El paso acaba de cambiar de
 * significado (de embudos a asistentes) y con un detalle de tres ramas, la
 * copia ya no era una línea que se re-escribe parecida: era una segunda
 * verdad esperando a desincronizarse. Acá vive una.
 *
 * Cuenta los asistentes ACTIVOS: `listAgents` trae también los apagados, y
 * una fila apagada no es un asistente — marcaría el paso en verde sobre un
 * negocio que no tiene a nadie contestando.
 */
export function verificarPasoAsistente(client: PoolClient, tenantId: string): Verificador {
  return async () => {
    const agentes = (await listAgents(client, tenantId)).filter((a) => a.active);
    return {
      hecho: agentes.length > 0,
      detalle:
        agentes.length === 1
          ? `Asistente «${agentes[0].name}»`
          : agentes.length > 1
            ? `${agentes.length} asistentes`
            : 'todavía no tienes asistente',
    };
  };
}
