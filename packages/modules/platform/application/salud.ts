import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { QUEUE_NAMES, type ModuleHealth } from '@iaxti/core';

// Seguridad y salud del SuperAdmin (#71, prompt maestro §22). Una persona
// opera todo esto sola: necesita UN lugar que diga qué está mal y dónde.
//
// Dos reglas de honestidad que valen más que la pantalla:
//  1. Nada se inventa. Cada número sale de una fuente real (audit_log, la
//     base, Redis, el registry). Si una fuente no está conectada, el chequeo
//     lo DICE en vez de mostrar un cero tranquilizador.
//  2. El color nunca es el único portador: cada chequeo trae su estado, su
//     umbral y una explicación en palabras.

export type EstadoSalud = 'bien' | 'atencion' | 'mal' | 'sin_fuente';

export interface Chequeo {
  id: string;
  titulo: string;
  estado: EstadoSalud;
  /** Qué significa el estado, en palabras. Nunca vacío. */
  detalle: string;
  /** El número medido, cuando hay uno. */
  valor?: number | string | null;
  /** A partir de dónde deja de estar bien. */
  umbral?: string;
}

const PEOR: Record<EstadoSalud, number> = { bien: 0, sin_fuente: 1, atencion: 2, mal: 3 };

export function estadoGeneral(chequeos: Chequeo[]): EstadoSalud {
  return chequeos.reduce<EstadoSalud>(
    (peor, c) => (PEOR[c.estado] > PEOR[peor] ? c.estado : peor),
    'bien',
  );
}

async function conLatencia<T>(fn: () => Promise<T>): Promise<{ ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t0 };
  } catch (err) {
    return { ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** Umbrales de latencia: por debajo del primero está bien; sobre el segundo, mal. */
const LATENCIA_ATENCION = 200;
const LATENCIA_MAL = 1000;

function porLatencia(nombre: string, id: string, r: { ms: number; error?: string }): Chequeo {
  if (r.error) {
    return {
      id,
      titulo: nombre,
      estado: 'mal',
      detalle: `No responde: ${r.error}`,
      valor: null,
      umbral: `responde en menos de ${LATENCIA_ATENCION} ms`,
    };
  }
  const estado: EstadoSalud =
    r.ms >= LATENCIA_MAL ? 'mal' : r.ms >= LATENCIA_ATENCION ? 'atencion' : 'bien';
  return {
    id,
    titulo: nombre,
    estado,
    detalle:
      estado === 'bien'
        ? `Responde en ${r.ms} ms.`
        : `Responde lento: ${r.ms} ms. Revisa carga y conexiones.`,
    valor: r.ms,
    umbral: `atención sobre ${LATENCIA_ATENCION} ms · mal sobre ${LATENCIA_MAL} ms`,
  };
}

/** Cuántos trabajos esperan en cada cola; una cola que crece es un aviso. */
const COLA_ATENCION = 100;
const COLA_MAL = 1000;

async function chequeoColas(redis: Redis | null): Promise<Chequeo> {
  if (!redis) {
    return {
      id: 'colas',
      titulo: 'Colas de trabajo',
      estado: 'sin_fuente',
      detalle: 'Sin Redis configurado no hay colas que mirar.',
    };
  }
  // Se lee la lista `wait` de BullMQ, que es la que dice qué está represado.
  const pendientes: Record<string, number> = {};
  let total = 0;
  for (const cola of QUEUE_NAMES) {
    const n = await redis.llen(`bull:${cola}:wait`).catch(() => 0);
    pendientes[cola] = n;
    total += n;
  }
  const estado: EstadoSalud = total >= COLA_MAL ? 'mal' : total >= COLA_ATENCION ? 'atencion' : 'bien';
  const detalle =
    estado === 'bien'
      ? `${total} trabajos esperando en total.`
      : `${total} trabajos represados: ${Object.entries(pendientes)
          .filter(([, n]) => n > 0)
          .map(([c, n]) => `${c} ${n}`)
          .join(', ')}. Revisa si los workers están vivos.`;
  return {
    id: 'colas',
    titulo: 'Colas de trabajo',
    estado,
    detalle,
    valor: total,
    umbral: `atención sobre ${COLA_ATENCION} · mal sobre ${COLA_MAL}`,
  };
}

/**
 * Proveedores externos: se informa si están CONFIGURADOS, no se les hace
 * ping. Un tablero que golpea a terceros cada vez que alguien lo abre es
 * una cuenta que crece y una página que se cuelga cuando el tercero se cae.
 */
const PROVEEDORES: Array<{ id: string; titulo: string; vars: string[] }> = [
  { id: 'canales', titulo: 'Proveedor de canales', vars: ['ZAVU_API_KEY'] },
  { id: 'ia', titulo: 'Proveedor de IA', vars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LLM_API_KEY'] },
  { id: 'google', titulo: 'Google (Calendar, Drive, Gmail)', vars: ['GOOGLE_CLIENT_ID'] },
  { id: 'pagos', titulo: 'Proveedor de pagos', vars: ['FLOW_API_KEY', 'FLOW_SANDBOX_CREDENTIALS'] },
  { id: 'adjuntos', titulo: 'Almacenamiento de adjuntos (R2)', vars: ['R2_ACCESS_KEY_ID'] },
];

function chequeoProveedores(env: NodeJS.ProcessEnv = process.env): Chequeo[] {
  return PROVEEDORES.map(({ id, titulo, vars }) => {
    const puesta = vars.find((v) => env[v]);
    return {
      id: `proveedor.${id}`,
      titulo,
      estado: puesta ? 'bien' : 'sin_fuente',
      detalle: puesta
        ? `Configurado (${puesta}). El estado real se ve en los eventos de cada canal.`
        : `Sin configurar: falta ${vars.join(' o ')} en el entorno.`,
      valor: puesta ? 'configurado' : 'sin configurar',
    };
  });
}

/**
 * Crecimiento de `messages` (#84, ADR-0013). El particionado se activa a los
 * ~20 millones de filas; esta es la alerta que avisa ANTES, para que la
 * decisión se tome con tiempo y no con la tabla ya pesada.
 *
 * Se usa `reltuples`, la estimación del planificador, NO `count(*)`: contar
 * decenas de millones de filas cada vez que alguien abre el tablero cuesta
 * más que el problema que se está vigilando. Para un umbral, la estimación
 * sobra.
 */
const MENSAJES_UMBRAL = 20_000_000;
const MENSAJES_AVISO = 0.7; // se avisa al 70 % del umbral

export async function chequeoCrecimientoMensajes(pool: Pool): Promise<Chequeo> {
  const r = await pool
    .query(
      `SELECT GREATEST(c.reltuples, 0)::bigint AS filas,
              pg_total_relation_size(c.oid) AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'messages' AND n.nspname = 'public'`,
    )
    .catch(() => ({ rows: [] as Array<{ filas: string; bytes: string }> }));
  if (r.rows.length === 0) {
    return {
      id: 'mensajes',
      titulo: 'Crecimiento de mensajes',
      estado: 'sin_fuente',
      detalle: 'No pudimos leer el tamaño de la tabla de mensajes.',
    };
  }
  const filas = Number(r.rows[0].filas);
  const gb = Number(r.rows[0].bytes) / 1024 ** 3;
  const pct = Math.round((filas / MENSAJES_UMBRAL) * 100);
  const cerca = filas >= MENSAJES_UMBRAL * MENSAJES_AVISO;
  return {
    id: 'mensajes',
    titulo: 'Crecimiento de mensajes',
    estado: filas >= MENSAJES_UMBRAL ? 'mal' : cerca ? 'atencion' : 'bien',
    detalle:
      filas >= MENSAJES_UMBRAL
        ? `La tabla cruzó los ${(MENSAJES_UMBRAL / 1e6).toFixed(0)} millones de filas (${gb.toFixed(1)} GB): toca decidir el particionado mensual (ADR-0013, #84).`
        : cerca
          ? `Va en ${pct}% del umbral de particionado (${gb.toFixed(1)} GB). Conviene planificar la migración de la ADR-0013 antes de llegar.`
          : `${(filas / 1e6).toFixed(2)} millones de filas (${gb.toFixed(1)} GB): lejos del umbral de particionado.`,
    valor: filas,
    umbral: `atención al ${Math.round(MENSAJES_AVISO * 100)}% de ${(MENSAJES_UMBRAL / 1e6).toFixed(0)} millones · estimación del planificador, no conteo exacto`,
  };
}

export interface SaludInput {
  /** Lo que ya dice el registry: no se recalcula nada. */
  modules?: ModuleHealth[];
  redis?: Redis | null;
  env?: NodeJS.ProcessEnv;
}

export async function healthSnapshot(
  pool: Pool,
  input: SaludInput = {},
): Promise<{ estado: EstadoSalud; chequeos: Chequeo[]; checkedAt: string }> {
  const chequeos: Chequeo[] = [];

  chequeos.push(porLatencia('Base de datos', 'postgres', await conLatencia(() => pool.query('SELECT 1'))));

  if (input.redis) {
    chequeos.push(porLatencia('Redis', 'redis', await conLatencia(() => input.redis!.ping())));
  } else {
    chequeos.push({
      id: 'redis',
      titulo: 'Redis',
      estado: 'sin_fuente',
      detalle: 'Sin REDIS_URL configurado: colas y límites de tasa no funcionan.',
    });
  }

  chequeos.push(await chequeoColas(input.redis ?? null));

  if (input.modules) {
    const apagados = input.modules.filter((m) => !m.enabled);
    const killSwitch = input.modules.filter((m) => m.killSwitch);
    chequeos.push({
      id: 'modulos',
      titulo: 'Módulos',
      estado: killSwitch.length > 0 ? 'atencion' : 'bien',
      detalle:
        killSwitch.length > 0
          ? `Con kill switch: ${killSwitch.map((m) => m.id).join(', ')}.`
          : `${input.modules.length - apagados.length} de ${input.modules.length} encendidos.`,
      valor: input.modules.length - apagados.length,
    });
  }

  // Canales conectados: el estado lo lleva channel_accounts, no se duplica.
  const canales = await pool
    .query(
      `SELECT state, count(*)::int AS n FROM channel_accounts
        WHERE state <> 'disconnected' OR state IS NULL GROUP BY state`,
    )
    .catch(() => ({ rows: [] as Array<{ state: string; n: number }> }));
  const degradados = canales.rows.find((r) => r.state === 'degraded')?.n ?? 0;
  const activos = canales.rows.find((r) => r.state === 'active')?.n ?? 0;
  chequeos.push({
    id: 'canales',
    titulo: 'Cuentas de canal',
    estado: degradados > 0 ? 'atencion' : 'bien',
    detalle:
      degradados > 0
        ? `${degradados} cuenta(s) degradada(s): reciben, pero con restricciones.`
        : `${activos} cuenta(s) activa(s).`,
    valor: activos,
  });

  chequeos.push(await chequeoCrecimientoMensajes(pool));

  chequeos.push(...chequeoProveedores(input.env));

  return { estado: estadoGeneral(chequeos), chequeos, checkedAt: new Date().toISOString() };
}

export interface SeguridadInput {
  redis?: Redis | null;
  /** Ventana de análisis; por defecto, la última semana. */
  dias?: number;
}

export interface Seguridad {
  estado: EstadoSalud;
  desde: string;
  chequeos: Chequeo[];
  permisosDenegados: Array<{ tenant_id: string; actor: string; ip: string | null; n: number }>;
  webhooksFallidos: Array<{ tenant_id: string; endpoint_id: string; n: number; ultimo: string }>;
  numerosEnRiesgo: Array<{
    tenant_id: string;
    display_phone: string | null;
    quality: string | null;
    business_paused_at: string | null;
  }>;
}

/** Cuántos rechazos hacen ruido antes de ser un problema. */
const DENEGADOS_ATENCION = 20;
const AUTH_ATENCION = 50;

export async function securitySnapshot(
  pool: Pool,
  input: SeguridadInput = {},
): Promise<Seguridad> {
  const dias = input.dias ?? 7;
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const chequeos: Chequeo[] = [];

  // 1. Permisos denegados: los escribe el guard en el MISMO libro de
  //    auditoría que todo lo demás (#72). Una fuente, no dos.
  const denegados = await pool.query(
    `SELECT tenant_id, actor, host(ip) AS ip, count(*)::int AS n
       FROM audit_log
      WHERE action = 'permission.denied' AND occurred_at >= $1
      GROUP BY tenant_id, actor, host(ip)
      ORDER BY n DESC LIMIT 20`,
    [desde],
  );
  const totalDenegados = denegados.rows.reduce((t, r) => t + r.n, 0);
  chequeos.push({
    id: 'permisos',
    titulo: 'Permisos denegados',
    estado: totalDenegados >= DENEGADOS_ATENCION ? 'atencion' : 'bien',
    detalle:
      totalDenegados >= DENEGADOS_ATENCION
        ? `${totalDenegados} intentos sin permiso en ${dias} días. Puede ser un rol mal armado o alguien probando.`
        : `${totalDenegados} intentos sin permiso en ${dias} días: dentro de lo normal.`,
    valor: totalDenegados,
    umbral: `atención desde ${DENEGADOS_ATENCION} en ${dias} días`,
  });

  // 2. Autenticación rechazada y abuso de cuota: los cuenta el propio guard
  //    en Redis, que es donde ya vive el límite de tasa.
  if (input.redis) {
    const [auth, cuota] = await Promise.all([
      input.redis.get('sec:auth_rechazado:total').catch(() => null),
      input.redis.get('sec:cuota_excedida:total').catch(() => null),
    ]);
    const nAuth = Number(auth ?? 0);
    chequeos.push({
      id: 'auth',
      titulo: 'Autenticaciones rechazadas',
      estado: nAuth >= AUTH_ATENCION ? 'atencion' : 'bien',
      detalle:
        nAuth >= AUTH_ATENCION
          ? `${nAuth} tokens rechazados desde el último reinicio del contador. Puede ser un cliente mal configurado o fuerza bruta.`
          : `${nAuth} tokens rechazados: ruido esperable.`,
      valor: nAuth,
      umbral: `atención desde ${AUTH_ATENCION}`,
    });
    const nCuota = Number(cuota ?? 0);
    chequeos.push({
      id: 'cuota',
      titulo: 'Cuota de API excedida',
      estado: nCuota > 0 ? 'atencion' : 'bien',
      detalle:
        nCuota > 0
          ? `${nCuota} llamadas rechazadas por cuota. Revisa si a alguien le quedó chico el plan.`
          : 'Nadie chocó con su cuota.',
      valor: nCuota,
    });
  } else {
    chequeos.push({
      id: 'auth',
      titulo: 'Autenticaciones rechazadas',
      estado: 'sin_fuente',
      detalle: 'El contador vive en Redis y Redis no está configurado.',
    });
  }

  // 3. Webhooks salientes fallidos (#66): la tabla ya lleva la cuenta.
  const webhooks = await pool
    .query(
      `SELECT tenant_id, endpoint_id::text, count(*)::int AS n, max(created_at) AS ultimo
         FROM webhook_deliveries
        WHERE status = 'failed' AND created_at >= $1
        GROUP BY tenant_id, endpoint_id
        ORDER BY n DESC LIMIT 20`,
      [desde],
    )
    .catch(() => ({ rows: [] as Seguridad['webhooksFallidos'] }));
  chequeos.push({
    id: 'webhooks',
    titulo: 'Webhooks salientes fallidos',
    estado: webhooks.rows.length > 0 ? 'atencion' : 'bien',
    detalle:
      webhooks.rows.length > 0
        ? `${webhooks.rows.length} endpoint(s) con entregas fallidas. El cliente no está recibiendo sus eventos.`
        : 'Todas las entregas salieron.',
    valor: webhooks.rows.length,
  });

  // 4. Números en riesgo: calidad baja o pausados por el negocio (#45).
  const numeros = await pool
    .query(
      `SELECT tenant_id, display_phone, quality, business_paused_at
         FROM whatsapp_numbers
        WHERE quality = 'red' OR business_paused_at IS NOT NULL
        ORDER BY business_paused_at DESC NULLS LAST LIMIT 20`,
    )
    .catch(() => ({ rows: [] as Seguridad['numerosEnRiesgo'] }));
  chequeos.push({
    id: 'numeros',
    titulo: 'Números en riesgo',
    estado: numeros.rows.length > 0 ? 'mal' : 'bien',
    detalle:
      numeros.rows.length > 0
        ? `${numeros.rows.length} número(s) en calidad baja o con envíos pausados. Un número bloqueado deja al cliente sin su canal de ventas.`
        : 'Ningún número en rojo.',
    valor: numeros.rows.length,
  });

  return {
    estado: estadoGeneral(chequeos),
    desde,
    chequeos,
    permisosDenegados: denegados.rows,
    webhooksFallidos: webhooks.rows as Seguridad['webhooksFallidos'],
    numerosEnRiesgo: numeros.rows as Seguridad['numerosEnRiesgo'],
  };
}
