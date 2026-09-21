import IORedis from 'ioredis';
import { Client } from 'pg';

type ProbeResult = 'ok' | 'sin configurar' | 'no disponible' | 'no respondió a tiempo';

/** Conexiones de diagnóstico acotadas; nunca toma ni modifica trabajos. */
export async function consumerReadiness(
  service: 'workers' | 'agents',
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 2_000,
  initialized = true,
) {
  async function probe(kind: 'redis' | 'database', url: string | undefined): Promise<ProbeResult> {
    if (!url?.trim()) return 'sin configurar';
    let close: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      const protocol = new URL(url).protocol;
      if (!(kind === 'redis' ? ['redis:', 'rediss:'] : ['postgres:', 'postgresql:']).includes(protocol)) {
        return 'no disponible';
      }
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('deadline')); }, timeoutMs);
      });
      const work = (async () => {
        if (kind === 'redis') {
          const client = new IORedis(url, {
            lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
            connectTimeout: timeoutMs, retryStrategy: () => null,
          });
          client.on('error', () => {}); // El resultado público se redacta abajo.
          close = () => client.disconnect();
          await client.connect();
          await client.ping();
        } else {
          const client = new Client({ connectionString: url, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
          client.on('error', () => {});
          close = () => { void client.end().catch(() => {}); };
          await client.connect();
          await client.query('SELECT 1');
        }
      })();
      await Promise.race([work, deadline]);
      return 'ok';
    } catch {
      return expired ? 'no respondió a tiempo' : 'no disponible';
    } finally {
      clearTimeout(timer);
      close?.();
    }
  }

  const [redis, database] = await Promise.all([
    probe('redis', env.REDIS_URL),
    service === 'workers' ? probe('database', env.DATABASE_URL) : Promise.resolve(undefined),
  ]);
  const ok = initialized && redis === 'ok' && (service !== 'workers' || database === 'ok');
  return {
    statusCode: ok ? 200 : 503,
    body: {
      status: ok ? 'ok' : 'degraded', service, redis,
      ...(service === 'workers' ? { database, startup: initialized ? 'ok' : 'iniciando' } : {}),
    },
  };
}
