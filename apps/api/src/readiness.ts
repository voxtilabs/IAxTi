import type { Pool } from 'pg';
import { redisConnection } from '@iaxti/core';

// Readiness de verdad (#17). `/health` y `/ready` NO son lo mismo y
// confundirlos es peor que no tener ninguno:
//
//  · `/health` = ¿el proceso está vivo? Si responde que no, lo REINICIAN.
//    Por eso no mira dependencias: reiniciar la app porque la base está
//    lenta no arregla la base, y sí tira al suelo lo que todavía funciona.
//
//  · `/ready` = ¿puede atender tráfico AHORA? Si responde que no, dejan de
//    mandarle pedidos pero no lo matan. Acá sí se miran las dependencias,
//    porque un proceso vivo sin base no puede contestar nada útil.
//
// Devolvía `ok` incondicionalmente, y el chart de Kubernetes (#83) apunta su
// readinessProbe justo acá: un pod con la base caída se habría declarado
// listo y habría recibido tráfico — exactamente lo que la sonda existe para
// evitar.

export interface Dependencia {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

export interface Readiness {
  status: 'ok' | 'degraded';
  service: string;
  dependencias: Dependencia[];
}

/** Tope duro: una sonda que espera es una sonda que miente sobre el estado. */
const TIMEOUT_MS = 2000;

async function conTope<T>(fn: () => Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no respondió en ${ms} ms`)), ms).unref?.(),
    ),
  ]);
}

async function medir(nombre: string, fn: () => Promise<unknown>): Promise<Dependencia> {
  const t0 = Date.now();
  try {
    await conTope(fn);
    return { nombre, ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { nombre, ok: false, ms: Date.now() - t0, detalle: (err as Error).message };
  }
}

let redisSonda: ReturnType<typeof redisConnection> | null = null;

export async function checkReadiness(pool: Pool | null, service = 'api'): Promise<Readiness> {
  const dependencias: Dependencia[] = [];

  if (pool) {
    dependencias.push(await medir('postgres', () => pool.query('SELECT 1')));
  } else {
    // Sin base configurada la API no sirve para nada: no está lista.
    dependencias.push({
      nombre: 'postgres',
      ok: false,
      ms: 0,
      detalle: 'Sin DATABASE_URL configurada.',
    });
  }

  if (process.env.REDIS_URL) {
    redisSonda ??= redisConnection();
    dependencias.push(await medir('redis', () => redisSonda!.ping()));
  } else {
    // En desarrollo se corre sin Redis a propósito; no es motivo para
    // sacar la instancia de rotación.
    dependencias.push({
      nombre: 'redis',
      ok: true,
      ms: 0,
      detalle: 'Sin REDIS_URL: colas y límites de tasa apagados.',
    });
  }

  return {
    status: dependencias.every((d) => d.ok) ? 'ok' : 'degraded',
    service,
    dependencias,
  };
}
