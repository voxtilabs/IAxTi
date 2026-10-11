import { readFileSync } from 'node:fs';

/**
 * El catálogo de eventos del SPEC §24 y los manifiestos dicen lo mismo (#828).
 *
 * ## Por qué hacía falta
 *
 * SPEC §24 lista los eventos por módulo y cierra con la regla: «Agregar un
 * evento es editar el manifiesto del módulo que lo publica y esta lista». Nada
 * lo comprobaba, y las dos listas se habían separado en las dos direcciones:
 *
 *  - **cuatro** eventos que el catálogo prometía y ningún módulo declaraba
 *    —`knowledge.updated`, `integration.connected`, `integration.revoked`,
 *    `subscription.changed`—. Quien leyera el catálogo y cableara un consumidor
 *    a uno de ellos esperaba para siempre, sin error y sin aviso;
 *  - y **dieciocho** eventos reales que el catálogo no nombraba, el módulo
 *    `whatsapp` entero entre ellos.
 *
 * Es el tercer lado del triángulo. `eventos-declarados.test.ts` cuida
 * manifiesto↔código (#792) y el espejo de los consumidores; faltaba
 * catálogo↔manifiesto, que es el lado que lee una persona cuando pregunta «¿de
 * qué me puedo enterar?».
 *
 * ## Por qué el SPEC se parsea y no se duplica
 *
 * Porque una tercera copia de la lista sería el mismo defecto con un nombre
 * nuevo. Lo que se compara es el documento mismo.
 */

/** Lo que el bloque de §24 enumera, por nombre de evento. */
export function eventosDelCatalogo(spec: string): Set<string> {
  const ini = spec.indexOf('identity        user.registered');
  const fin = spec.indexOf('Agregar un evento es editar el manifiesto');
  if (ini === -1 || fin === -1 || fin < ini) {
    throw new Error(
      'no se encontró el bloque del catálogo de eventos en el SPEC §24. Si se movió o se ' +
        'renombró, hay que actualizar estos dos marcadores: sin ellos la guarda no mide nada.',
    );
  }
  const bloque = spec.slice(ini, fin);
  const eventos = new Set<string>();
  for (const m of bloque.matchAll(/\b([a-z_]+\.[a-z_.]+)\b/g)) eventos.add(m[1]);
  return eventos;
}

export function eventosDelCatalogoEnArchivo(rutaDelSpec: string): Set<string> {
  return eventosDelCatalogo(readFileSync(rutaDelSpec, 'utf8'));
}
