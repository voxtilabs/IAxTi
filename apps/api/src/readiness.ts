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

/**
 * El motivo del último fallo de cada dependencia.
 *
 * El tope corta a los 2 s y el error de verdad llega después —el pool se
 * rinde a los 5—, así que la carrera siempre la gana el tope y `/ready`
 * decía "no respondió en 2000 ms" y nada más. Eso es cierto y no sirve:
 * staging estuvo días diciendo exactamente eso, y el motivo —los paquetes
 * no llegaban a Supabase— hubo que buscarlo desde el otro lado.
 *
 * Ahora la promesa lenta se sigue escuchando aunque el tope haya ganado, y
 * lo que diga se guarda para la sonda siguiente. La primera vez se ve el
 * timeout; de ahí en adelante, la causa.
 *
 * Distinguir importa: `ENOTFOUND` es DNS, `ETIMEDOUT` o "connection timeout"
 * es que los paquetes se pierden, `ECONNREFUSED` es que no hay nadie
 * escuchando. Tres problemas distintos que antes se veían igual.
 */
const ultimoFallo = new Map<string, string>();

async function medir(nombre: string, fn: () => Promise<unknown>): Promise<Dependencia> {
  const t0 = Date.now();
  const real = fn();
  // Se le engancha el catch ANTES de la carrera: si no, una promesa que
  // rechaza después del tope queda sin manejar y Node se queja.
  real.then(
    () => ultimoFallo.delete(nombre),
    (err: Error) => ultimoFallo.set(nombre, err.message),
  );

  try {
    await Promise.race([
      real,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`no respondió en ${TIMEOUT_MS} ms`)), TIMEOUT_MS).unref?.(),
      ),
    ]);
    return { nombre, ok: true, ms: Date.now() - t0 };
  } catch (err) {
    const previo = ultimoFallo.get(nombre);
    const detalle = (err as Error).message;
    return {
      nombre,
      ok: false,
      ms: Date.now() - t0,
      detalle: previo && previo !== detalle ? `${detalle} — la vez anterior: ${previo}` : detalle,
    };
  }
}

let redisSonda: ReturnType<typeof redisConnection> | null = null;

/**
 * A qué puerto está intentando conectarse, sin decir nada más.
 *
 * Un timeout de Postgres se ve idéntico venga del puerto que venga, y desde
 * afuera no hay forma de saber si el contenedor tomó el valor nuevo de la
 * configuración o sigue con el viejo. Eso convirtió un cambio de un carácter
 * en media hora de adivinar: "¿ya está desplegado o todavía no?".
 *
 * Solo el PUERTO. Ni host, ni usuario, ni base, ni contraseña — un
 * diagnóstico no justifica publicar a dónde nos conectamos. El puerto solo no
 * identifica nada: en Supabase es 5432 o 6543 y ya está escrito en el SPEC.
 */
function puertoDeLaBase(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const p = new URL(url).port;
    return p || '5432'; // sin puerto explícito, el de Postgres por defecto
  } catch {
    return null;
  }
}

export async function checkReadiness(pool: Pool | null, service = 'api'): Promise<Readiness> {
  const dependencias: Dependencia[] = [];

  if (pool) {
    const sonda = await medir('postgres', () => pool.query('SELECT 1'));
    // El puerto solo cuando FALLA: en verde es ruido, y en rojo es lo primero
    // que uno quiere saber.
    const puerto = sonda.ok ? null : puertoDeLaBase();
    dependencias.push(
      puerto ? { ...sonda, detalle: `${sonda.detalle ?? 'no conecta'} (puerto ${puerto})` } : sonda,
    );
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
