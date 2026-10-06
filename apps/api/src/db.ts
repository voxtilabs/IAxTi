import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import { createPool } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';

let pool: Pool | null = null;
/**
 * Un pool puesto desde afuera (tests).
 *
 * Sin esto, la única forma de que la API hablara con OTRA base era cambiar
 * `process.env.DATABASE_URL`, y eso es una variable del PROCESO: vitest
 * corre varios archivos en hilos que comparten el mismo, así que un test
 * que apuntaba la API a un puerto muerto —para comprobar que un webhook
 * responde 503 y no 500— le cambiaba la base a los que corrían al lado.
 * Fallaban archivos al azar, y parecía culpa de la máquina.
 */
let inyectado: Pool | null = null;

/** Pool único de la API; null si el ambiente no tiene base configurada. */
export function apiPool(): Pool | null {
  if (inyectado) return inyectado;
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = createPool();
  return pool;
}

/** Solo para tests: fija el pool que usará la API, sin tocar el entorno. */
export function usarPool(p: Pool | null): void {
  inyectado = p;
}

/**
 * Redis único para el caché de lecturas (#711).
 *
 * Misma forma que el pool y por la misma razón: `redisConnection()` abre una
 * conexión cada vez que se la llama, y hacerlo por petición sería cambiar
 * 64 ms de base por un saludo TCP en cada request.
 *
 * Devuelve `null` cuando no hay `REDIS_URL`. Quien lo use tiene que seguir
 * funcionando sin caché —`leerConCache` lo hace— porque un ambiente sin Redis
 * es legítimo y no puede quedarse sin lecturas.
 */
let redis: IORedis | null = null;
let redisInyectado: IORedis | null = null;

export function apiRedis(): IORedis | null {
  if (redisInyectado) return redisInyectado;
  if (!process.env.REDIS_URL) return null;
  if (!redis) redis = redisConnection();
  return redis;
}

/** Solo para tests, igual que `usarPool`. */
export function usarRedis(r: IORedis | null): void {
  redisInyectado = r;
}
