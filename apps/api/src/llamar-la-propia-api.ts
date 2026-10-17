import { enteroDeEntorno } from '@iaxti/core';
import type { Actor, WithUser } from './authz/authz.guard';

/**
 * Llamar a nuestra propia API con la identidad de quien pidió (ADR-0025).
 *
 * Es la pieza que hace cierta la regla del catálogo: «la herramienta no es más
 * que la ruta». Lo que el agente hace pasa por el mismo endpoint, los mismos
 * guards, el mismo audit y las mismas validaciones que si una persona lo
 * hubiera apretado — porque literalmente es eso.
 *
 * Vive acá y no en un controlador porque lo usan DOS: el Agente General, que
 * aplica lo que propuso conversando, y la bandeja, que aplica la acción que el
 * asistente dejó junto a su respuesta (#999). Copiarlo habría sido el segundo
 * camino con reglas propias que ADR-0025 vino a evitar.
 */
export function llamarLaPropiaApi(request: WithUser) {
  const base = `http://127.0.0.1:${enteroDeEntorno('PORT', 3000)}`;
  const credencial: Record<string, string> = request.headers['x-api-key']
    ? { 'X-Api-Key': String(request.headers['x-api-key']) }
    : { Authorization: String(request.headers.authorization ?? '') };
  const tenantId = (request.actor as Actor).tenantId;

  return async (peticion: {
    metodo: string;
    ruta: string;
    query: Record<string, string>;
    cuerpo: Record<string, unknown> | null;
  }) => {
    const qs = new URLSearchParams(peticion.query).toString();
    const cabeceras: Record<string, string> = {
      ...credencial,
      'X-Tenant-Id': tenantId,
      // El MISMO trace: lo que haga el agente se sigue en los logs junto
      // con la conversación que lo pidió.
      ...(request.requestId ? { 'X-Request-Id': request.requestId } : {}),
      ...(peticion.cuerpo ? { 'Content-Type': 'application/json' } : {}),
    };
    const res = await fetch(`${base}${peticion.ruta}${qs ? `?${qs}` : ''}`, {
      method: peticion.metodo,
      headers: cabeceras,
      ...(peticion.cuerpo ? { body: JSON.stringify(peticion.cuerpo) } : {}),
    });
    const datos = await res.json().catch(() => null);
    return { ok: res.ok, estado: res.status, datos };
  };
}
