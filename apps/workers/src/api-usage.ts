import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import { withTenant } from '@iaxti/db';
import { incrementUsage } from '@iaxti/module-organizations';
import { bump } from '@iaxti/module-analytics';

// El volcado del consumo de API (#26): los contadores por día y por
// endpoint que dejó el guard (#25) en Redis pasan a usage_meters (la
// fuente, SPEC) y a daily_metrics (la evolución del dashboard). GETDEL:
// lo volcado no se cuenta dos veces.

async function scanKeys(redis: IORedis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, lote] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...lote);
  } while (cursor !== '0');
  return keys;
}

export async function flushApiUsage(pool: Pool, redis: IORedis): Promise<number> {
  let volcadas = 0;

  for (const key of await scanKeys(redis, 'apiq:d:*')) {
    const valor = Number(await redis.getdel(key));
    if (!Number.isFinite(valor) || valor <= 0) continue;
    const [, , tenantId, dia] = key.split(':');
    await withTenant(pool, tenantId, async (client) => {
      await incrementUsage(client, tenantId, 'api_requests', valor, new Date(`${dia}T12:00:00Z`));
      await bump(client, { tenantId, metric: 'api_requests' as never, value: valor, day: new Date(`${dia}T12:00:00Z`) });
    });
    volcadas += 1;
  }

  for (const key of await scanKeys(redis, 'apiq:e:*')) {
    const valor = Number(await redis.getdel(key));
    if (!Number.isFinite(valor) || valor <= 0) continue;
    // apiq:e:<tenant>:<dia>:<METHOD /ruta> — la ruta puede traer ':'.
    const partes = key.split(':');
    const tenantId = partes[2];
    const dia = partes[3];
    const endpoint = partes.slice(4).join(':');
    await withTenant(pool, tenantId, (client) =>
      bump(client, {
        tenantId,
        metric: `api_ep:${endpoint}`.slice(0, 200) as never,
        value: valor,
        day: new Date(`${dia}T12:00:00Z`),
      }),
    );
    volcadas += 1;
  }
  return volcadas;
}
