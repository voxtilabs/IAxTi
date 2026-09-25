import { OPERACIONES_DE_LA_API, type OperacionDeLaApi } from './catalogo.generated';
import { DESCRIPCIONES, NO_SON_HERRAMIENTA, SIN_CONFIRMACION } from './catalogo-curado';

/**
 * El catálogo de herramientas del Agente General (#492, ADR-0025).
 *
 * Junta las dos mitades: el inventario generado del código y lo curado por
 * una persona. De acá sale la lista que se le ofrece al modelo.
 *
 * La regla que ordena todo: **la herramienta no es más que la ruta**. Cada
 * una es una llamada HTTP a su endpoint con la identidad de quien habla,
 * así que pasa por los mismos guards, el mismo audit y las mismas
 * validaciones que si la hubiera hecho una persona desde la pantalla. No
 * hay un segundo camino con reglas propias — que es justo como se filtran
 * los agujeros.
 */

export type TratoDeLaHerramienta = 'libre' | 'confirmar';

export interface Herramienta {
  /** Como la nombra el modelo: `contacts.actualizar`. */
  nombre: string;
  operationId: string;
  metodo: string;
  /** Con `{id}`, tal como la publica el documento. */
  ruta: string;
  descripcion: string;
  permiso: string | null;
  modulo: string | null;
  /** `confirmar` = el dueño ve el diff y aplica; `libre` = se ejecuta. */
  trato: TratoDeLaHerramienta;
  argumentos: Record<string, unknown>;
}

/**
 * `ContactsController_actualizar` → `contacts.actualizar`.
 *
 * El nombre técnico del controlador no le dice nada al modelo y ocupa
 * tokens en cada llamada. Sale del operationId y no de un diccionario a
 * mano: un endpoint nuevo trae su nombre solo.
 */
export function nombreDeHerramienta(operationId: string): string {
  const [controlador, metodo] = operationId.split('_');
  const grupo = controlador.replace(/Controller$/, '');
  return `${grupo.charAt(0).toLowerCase()}${grupo.slice(1)}.${metodo}`;
}

/**
 * Cómo se trata una operación.
 *
 * El default es CONFIRMAR, y eso es a propósito: una herramienta nueva nace
 * pidiendo permiso, y bajarla a `libre` es una decisión escrita en
 * `SIN_CONFIRMACION`. Al revés —nacer libre y acordarse de subirla— es como
 * se cuelan las que no había que dejar pasar.
 */
export function tratoDe(operationId: string, metodo: string): TratoDeLaHerramienta {
  if (metodo === 'GET') return 'libre';
  return SIN_CONFIRMACION.has(operationId) ? 'libre' : 'confirmar';
}

function construir(): Herramienta[] {
  const salida: Herramienta[] = [];
  for (const [operationId, op] of Object.entries(OPERACIONES_DE_LA_API) as Array<
    [string, OperacionDeLaApi]
  >) {
    if (operationId in NO_SON_HERRAMIENTA) continue;
    salida.push({
      nombre: nombreDeHerramienta(operationId),
      operationId,
      metodo: op.metodo,
      ruta: op.ruta,
      descripcion: DESCRIPCIONES[operationId] ?? op.resumen,
      permiso: op.permiso,
      modulo: op.modulo,
      trato: tratoDe(operationId, op.metodo),
      argumentos: op.argumentos,
    });
  }
  return salida.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** Todas las herramientas que existen, sin filtrar por nadie. */
export const CATALOGO: Herramienta[] = construir();

/**
 * Las que puede usar QUIEN HABLA, no las que puede el agente.
 *
 * Es la misma regla del MCP (#419) y de las herramientas del copiloto: la
 * IA jamás puede hacer lo que la persona a cuyo nombre actúa no podría. Se
 * cruza por permiso y por módulo activo:
 *
 *  - sin el permiso, la herramienta ni siquiera se OFRECE (el modelo no
 *    puede pedir lo que no va a poder hacer, y así no gasta un turno en
 *    recibir un 403 que no entiende);
 *  - con el módulo apagado, tampoco: en ese tenant esa función no existe.
 */
export function herramientasPara(input: {
  permisos: ReadonlySet<string>;
  modulosActivos: ReadonlySet<string>;
}): Herramienta[] {
  return CATALOGO.filter(
    (h) =>
      (h.modulo === null || input.modulosActivos.has(h.modulo)) &&
      (h.permiso === null || input.permisos.has(h.permiso)),
  );
}
