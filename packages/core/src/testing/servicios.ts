import { connect } from 'node:net';

/**
 * Un rojo que dice qué falta, en vez de agotar el reloj (#1254).
 *
 * Varias suites de este repo montan servicios de verdad —una cola de BullMQ,
 * un Postgres, un Redis— porque la pregunta que contestan solo se contesta
 * ejercitándolos. El problema no es eso: es qué se ve cuando el servicio NO
 * está.
 *
 * Medido el 7 de noviembre, con Redis caído desde hacía trece horas:
 *
 *     × termina el job que está corriendo y NO toma el siguiente
 *       → Test timed out in 20000ms.
 *
 * Veinte segundos de espera y un mensaje que no menciona Redis en ninguna
 * parte. Estuve a punto de atribuirlo a mi cambio y buscar una regresión que
 * no existía. Y es peor que una pérdida de tiempo: un rojo que no habla del
 * cambio enseña a ignorar el rojo, que es exactamente lo que #1254 vino a
 * evitar.
 *
 * Se comprueba con un socket y no con el cliente del servicio: un `ioredis`
 * reintenta solo —que es lo correcto en producción y lo peor acá— y deja la
 * conexión viva para que la suite siga colgada.
 */

/** Cómo se levanta cada cosa, para poder decirlo en el mensaje. */
const COMO_SE_LEVANTA: Record<string, string> = {
  Redis: 'docker start lino-redis-1   (o: docker compose up -d redis)',
  PostgreSQL: 'docker compose up -d postgres',
};

export async function exigirServicio(
  url: string,
  nombre: string,
  plazoMs = 1_500,
): Promise<void> {
  const { hostname, port } = new URL(url);
  const donde = `${hostname}:${port || '(sin puerto)'}`;
  const comoLevantarlo = COMO_SE_LEVANTA[nombre] ? `\n  ${COMO_SE_LEVANTA[nombre]}` : '';
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) });
    const terminar = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(plazoMs, () =>
      terminar(
        new Error(
          `${nombre} no contesta en ${donde} (${plazoMs} ms). Esta suite lo monta de ` +
            `verdad, así que sin él se cuelga hasta el timeout y el error no lo menciona.` +
            comoLevantarlo,
        ),
      ),
    );
    socket.once('connect', () => terminar());
    socket.once('error', (causa: Error) =>
      terminar(
        new Error(
          `No hay ${nombre} escuchando en ${donde}: ${causa.message}. Esta suite lo monta ` +
            `de verdad, así que sin él se cuelga hasta el timeout y el error no lo menciona.` +
            comoLevantarlo,
        ),
      ),
    );
  });
}

/**
 * Las variables que la suite necesita, con el nombre a la vista.
 *
 * Reemplaza al `expect(process.env.X).toBeTruthy()` sin mensaje, que es lo que
 * había: cuando falla dentro de un `beforeAll` lo que se lee es el número de
 * línea, y además el `afterAll` revienta encima porque nada se llegó a crear.
 * Dos errores crípticos, y las once pruebas del archivo quedan contadas como
 * `skipped` — que se lee igual que «no tenían nada que decir».
 */
export function exigirVariables(nombres: string[], env: NodeJS.ProcessEnv = process.env): void {
  const faltan = nombres.filter((n) => !env[n]);
  if (faltan.length === 0) return;
  throw new Error(
    `Esta suite necesita ${faltan.join(', ')} y no está${faltan.length > 1 ? 'n' : ''} ` +
      `definida${faltan.length > 1 ? 's' : ''}. Córrela con scripts/antes-de-empujar.sh, ` +
      'que exporta la base y el Redis DE PRUEBAS, o expórtalas a mano.',
  );
}
