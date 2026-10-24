import type { PoolClient } from 'pg';
import {
  DEFAULT_TASK_MODELS,
  PROVIDERS,
  TASKS,
  proveedorPermitidoParaTarea,
  type AgentTask,
  type Esfuerzo,
  type Provider,
  type TaskModel,
} from '../domain/config';

/**
 * El proveedor y modelo por tarea de la PLATAFORMA, leído de la base (#858).
 *
 * Vivía compilado en `DEFAULT_TASK_MODELS`. El código sigue siendo la
 * SEMILLA: una tarea sin fila en la tabla usa su valor del repo, así que un
 * despliegue nuevo arranca con lo que dice el código y la tabla guarda solo lo
 * que alguien decidió cambiar.
 */

/**
 * Qué proveedores puede fijar alguien como defecto de la plataforma.
 *
 * Esto NO es una preferencia técnica: es dónde terminan los datos de los
 * clientes de nuestros clientes. `docs/COMPLIANCE_BASELINE.md` tiene una fila
 * por proveedor que dice qué sale hacia dónde, y el criterio de #858 es que
 * no se pueda hacer defecto a un proveedor cuya fila no lo declare.
 *
 * ## Por qué una constante y no leer la matriz
 *
 * Porque la matriz NO viaja en la imagen: el Dockerfile copia `apps` y
 * `packages`, no `docs`. Leerla en runtime fallaría en producción, y una
 * guarda que no puede correr donde importa es peor que no tenerla — queda
 * declarada y no aplicada, que es el defecto que este repo lleva semanas
 * sacando. Así que la lista vive acá, bloquea de verdad, y
 * `compliance-proveedores.test.ts` la ata al documento: agregar un proveedor
 * acá sin escribir su fila pone roja la guarda.
 */
export const PROVEEDORES_QUE_PUEDEN_SER_DEFECTO: readonly Provider[] = ['openai', 'google'];

export class ProveedorSinFilaDeCompliance extends Error {
  constructor(readonly proveedor: Provider) {
    super(
      `La matriz de compliance no declara a "${proveedor}" como proveedor por defecto. ` +
        'Escribí su fila en COMPLIANCE_BASELINE.md antes de hacerlo el defecto de la plataforma.',
    );
    this.name = 'ProveedorSinFilaDeCompliance';
  }
}

export class TareaQueElProveedorNoAtiende extends Error {
  constructor(readonly proveedor: Provider, readonly tarea: AgentTask) {
    super(
      `"${proveedor}" no puede atender "${tarea}". No es una política: es que el adaptador ` +
        'no habla la API que esa tarea necesita.',
    );
    this.name = 'TareaQueElProveedorNoAtiende';
  }
}

export interface DefectoDeLaTarea extends TaskModel {
  /** `false` cuando sale de la semilla del código y nadie lo cambió. */
  desdeLaBase: boolean;
  cambiadoPor: string | null;
  cambiadoEl: Date | null;
}

/**
 * Los nueve defectos, con el código como semilla y la base por encima.
 *
 * Devuelve SIEMPRE las nueve tareas: una tarea sin fila no es un hueco, es
 * «nadie la cambió todavía». Que el llamador tenga que lidiar con un
 * `undefined` sería trasladarle una diferencia que no le importa.
 */
export async function defectosDeLaPlataforma(
  client: PoolClient,
): Promise<Record<AgentTask, DefectoDeLaTarea>> {
  const filas = await client.query<{
    task: string;
    provider: string;
    model: string;
    esfuerzo: string | null;
    updated_by: string | null;
    updated_at: Date;
  }>('SELECT task, provider, model, esfuerzo, updated_by, updated_at FROM agent_task_defaults');
  const guardados = new Map(filas.rows.map((f) => [f.task, f]));

  const salida = {} as Record<AgentTask, DefectoDeLaTarea>;
  for (const task of TASKS) {
    const semilla = DEFAULT_TASK_MODELS[task];
    const fila = guardados.get(task);
    // Una fila con un proveedor que ya no existe en `PROVIDERS` —se retiró del
    // producto— se ignora y vuelve la semilla. Preferir la fila sería servir
    // con un adaptador que no está, y en silencio.
    if (!fila || !PROVIDERS.includes(fila.provider as Provider)) {
      salida[task] = { ...semilla, desdeLaBase: false, cambiadoPor: null, cambiadoEl: null };
      continue;
    }
    salida[task] = {
      provider: fila.provider as Provider,
      model: fila.model,
      ...(fila.esfuerzo ? { esfuerzo: fila.esfuerzo as Esfuerzo } : {}),
      desdeLaBase: true,
      cambiadoPor: fila.updated_by,
      cambiadoEl: fila.updated_at,
    };
  }
  return salida;
}

/**
 * Lo mismo, cacheado unos segundos.
 *
 * Cada llamada a la IA resuelve sus ajustes, y hacer un `SELECT` por cada una
 * sería pagar un viaje a la base en el camino más caliente del producto —el
 * mismo donde pasamos una semana bajando segundos—. La ventana es corta a
 * propósito: el punto de haber sacado esto del código era poder cambiarlo sin
 * despliegue, y un caché largo lo devolvería a «esperá a que se reinicie».
 *
 * En proceso y no en Redis, igual que los castigos (#855): son nueve filas y
 * cada instancia puede tener su copia unos segundos sin que nadie lo note.
 */
/**
 * Quince segundos, y sin variable de entorno.
 *
 * La primera versión lo hacía configurable con `IA_DEFECTO_CACHE_MS`. Dos
 * guardas del repo lo rechazaron y las dos tenían razón: la de #575 porque
 * `??` sobre una variable de entorno cae al defecto solo con `undefined` y no
 * con la cadena vacía que deja un compose con `${VAR:-}`, y la del compose
 * porque toda variable que el código lee tiene que estar declarada allá.
 *
 * Pero el arreglo correcto no era usar el ayudante: era no tener la variable.
 * Nadie pidió poder ajustar esto, y una perilla sin dueño es una forma de
 * configuración que hay que documentar, pasar por el compose y mantener.
 */
const VENTANA_MS = 15_000;
let cache: { leidoEn: number; valor: Record<AgentTask, TaskModel> } | null = null;

export async function semillaCacheada(
  client: PoolClient,
  ahora = Date.now(),
): Promise<Record<AgentTask, TaskModel>> {
  if (cache && ahora - cache.leidoEn < VENTANA_MS) return cache.valor;
  const valor = await semillaEfectiva(client);
  cache = { leidoEn: ahora, valor };
  return valor;
}

/**
 * Olvida lo cacheado. Para las pruebas, y para después de cambiar un defecto:
 * quien acaba de moverlo espera verlo aplicado, no en quince segundos.
 */
export function olvidarLaSemilla(): void {
  cache = null;
}

/** Lo mismo, en la forma que espera `iaSettings`: sin el quién ni el cuándo. */
export async function semillaEfectiva(
  client: PoolClient,
): Promise<Record<AgentTask, TaskModel>> {
  const todos = await defectosDeLaPlataforma(client);
  const salida = {} as Record<AgentTask, TaskModel>;
  for (const task of TASKS) {
    // Se arma el modelo en vez de destructurar lo que sobra: `iaSettings`
    // compara estos objetos y un campo de más —`desdeLaBase`— lo haría
    // distinto a la semilla sin que nada lo diga.
    const { provider, model, esfuerzo } = todos[task];
    salida[task] = { provider, model, ...(esfuerzo ? { esfuerzo } : {}) };
  }
  return salida;
}

/**
 * Cambia el defecto de una tarea, y lo deja en el libro.
 *
 * El `writeAudit` va en la MISMA transacción que el UPSERT, que es la regla
 * del repo y acá pesa más que de costumbre: esto decide hacia qué empresa, en
 * qué país, sale el texto de las conversaciones de todos los negocios. Un
 * cambio sin rastro de quién lo hizo es justo el que nadie va a poder explicar
 * después.
 */
export async function fijarDefectoDeLaTarea(
  client: PoolClient,
  entrada: {
    task: AgentTask;
    provider: Provider;
    model: string;
    esfuerzo?: Esfuerzo | null;
    actor: string;
    /**
     * Deja el rastro. Lo pone QUIEN LLAMA, y no se escribe acá.
     *
     * Este cambio es de la plataforma, no de un negocio, así que no va a
     * `audit_log` —su `tenant_id` es NOT NULL y apunta a `tenants`— sino a
     * `platform_audit`, que es del módulo `platform`. Escribirla desde acá
     * sería una escritura a tabla ajena, que la regla de `db.md` prohíbe
     * aunque el módulo esté declarado: rompería sus invariantes sin pasar por
     * su código, y su dueño no se enteraría.
     *
     * Así que el rastro lo escribe el controlador, que es la capa que conoce
     * a los dos módulos, y recibe el MISMO cliente para caer en la misma
     * transacción que el UPSERT. Si falla el rastro, no hay cambio.
     *
     * Es obligatorio a propósito: dejarlo opcional haría que olvidarlo
     * compile, y este es exactamente el cambio que nadie va a poder explicar
     * después si no quedó escrito.
     */
    auditar: (client: PoolClient, cambio: Record<string, unknown>) => Promise<void>;
  },
): Promise<DefectoDeLaTarea> {
  if (!(TASKS as readonly string[]).includes(entrada.task)) {
    throw new Error(`"${entrada.task}" no es una tarea del agente.`);
  }
  // La capacidad ANTES que la fila de compliance (#864): si el proveedor no
  // sabe hacer la tarea, escribirle su fila en la matriz no lo va a arreglar
  // — el error tiene que mandar a la causa que sí se puede atacar.
  if (!proveedorPermitidoParaTarea(entrada.provider, entrada.task)) {
    throw new TareaQueElProveedorNoAtiende(entrada.provider, entrada.task);
  }
  if (!PROVEEDORES_QUE_PUEDEN_SER_DEFECTO.includes(entrada.provider)) {
    throw new ProveedorSinFilaDeCompliance(entrada.provider);
  }
  const model = entrada.model.trim();
  if (!model) throw new Error('El modelo no puede ir vacío.');

  const antes = (await defectosDeLaPlataforma(client))[entrada.task];
  const fila = await client.query<{ updated_at: Date }>(
    `INSERT INTO agent_task_defaults (task, provider, model, esfuerzo, updated_by, updated_at)
          VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (task) DO UPDATE
            SET provider = EXCLUDED.provider, model = EXCLUDED.model,
                esfuerzo = EXCLUDED.esfuerzo, updated_by = EXCLUDED.updated_by,
                updated_at = now()
       RETURNING updated_at`,
    [entrada.task, entrada.provider, model, entrada.esfuerzo ?? null, entrada.actor],
  );

  await entrada.auditar(client, {
    tarea: entrada.task,
    antes: { provider: antes.provider, model: antes.model, esfuerzo: antes.esfuerzo ?? null },
    despues: { provider: entrada.provider, model, esfuerzo: entrada.esfuerzo ?? null },
    // Si venía de la semilla, el «antes» no estaba guardado en ninguna parte:
    // quien lea el libro necesita saber que era el del código.
    veniaDelCodigo: !antes.desdeLaBase,
  });

  // Quien acaba de moverlo espera verlo aplicado, no en quince segundos.
  olvidarLaSemilla();

  return {
    provider: entrada.provider,
    model,
    ...(entrada.esfuerzo ? { esfuerzo: entrada.esfuerzo } : {}),
    desdeLaBase: true,
    cambiadoPor: entrada.actor,
    cambiadoEl: fila.rows[0].updated_at,
  };
}
