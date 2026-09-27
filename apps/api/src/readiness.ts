import type { Pool } from 'pg';
import { redisConnection } from '@iaxti/core';
import { PROVIDERS, providerAvailable } from '@iaxti/module-agents';

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
  /**
   * Si esta dependencia en rojo saca la instancia de rotación.
   *
   * Por omisión sí: sin base no se puede contestar nada. La IA es la
   * excepción y va con `false` — que el asistente no pueda trabajar es grave,
   * pero la bandeja, el CRM y los webhooks siguen sirviendo, y responder 503
   * por eso dejaría al negocio sin atender a sus clientes para castigar una
   * variable de entorno. Se reporta, no se castiga.
   */
  bloquea?: boolean;
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
 * Cuando Postgres no conecta: ¿es ESE puerto, o el contenedor no tiene salida?
 *
 * Es la pregunta que se quedó sin responder durante horas con staging caído.
 * Redis no la contesta —vive en la misma red interna del compose, así que
 * responder en 2 ms no dice nada de la salida a internet— y desde afuera las
 * dos causas se ven idénticas: un timeout y nada más.
 *
 * Se prueba contra el MISMO Supabase, por 443. Eso parte el problema en dos
 * de una sola mirada:
 *
 *   443 ok  + 6543 no  → sale a internet, le bloquean el puerto de Postgres
 *   443 no  + 6543 no  → no tiene salida y el puerto no tiene nada que ver
 *
 * Solo corre cuando Postgres YA falló: en verde no se le hace ni una llamada
 * a nadie. Y NO decide la salud — una sonda de diagnóstico que tumbe el
 * servicio sería peor que el problema que viene a explicar.
 */
async function salidaAInternet(): Promise<string | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const inicio = Date.now();
  try {
    const control = new AbortController();
    const corte = setTimeout(() => control.abort(), 2000);
    try {
      await fetch(`${base.replace(/\/$/, '')}/auth/v1/health`, {
        method: 'GET',
        signal: control.signal,
      });
      return `sale a internet: sí (Supabase por 443 en ${Date.now() - inicio} ms)`;
    } finally {
      clearTimeout(corte);
    }
  } catch (err) {
    // Cualquier fallo sirve igual: lo que importa es que tampoco por 443.
    return `sale a internet: NO (${(err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message.slice(0, 60)})`;
  }
}

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
    if (sonda.ok) {
      dependencias.push(sonda);
    } else {
      // En rojo, las dos cosas que hacen falta para saber a quién llamar: a
      // qué puerto intentó, y si el contenedor sale a internet siquiera.
      const puerto = puertoDeLaBase();
      const salida = await salidaAInternet();
      const partes = [
        sonda.detalle ?? 'no conecta',
        puerto ? `puerto ${puerto}` : null,
        salida,
      ].filter(Boolean);
      dependencias.push({ ...sonda, detalle: partes.join(' · ') });
    }
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

  dependencias.push(credencialesDeIa());
  dependencias.push(credencialDelCanal());

  return {
    // Solo las que bloquean deciden si se sale de rotación.
    status: dependencias.every((d) => d.ok || d.bloquea === false) ? 'ok' : 'degraded',
    service,
    dependencias,
  };
}

/**
 * ¿Tiene este ambiente con qué hacer funcionar la IA? (#641)
 *
 * Existe porque la pregunta «¿llegó la llave al contenedor?» se volvió una
 * conversación, repetida, y nadie podía contestarla mirando: `/ready` decía
 * «ok» con las tres credenciales ausentes, porque solo miraba postgres y
 * redis. El diagnóstico completo (#614) vive en `/agents/diagnostico` y pide
 * sesión —está bien que la pida, ahí se nombran las variables—, así que para
 * saber si el despliegue quedó con IA había que entrar al producto.
 *
 * Acá va lo mínimo que responde la pregunta y **nada más**: cuántos
 * proveedores tienen credencial. Ni sus nombres, ni qué variable falta, ni un
 * pedazo de ninguna llave. Un número no le sirve a nadie de afuera y le
 * ahorra a quien opera tener que entrar a preguntar.
 *
 * `bloquea: false` a propósito: esto NO saca la instancia de rotación.
 */
/**
 * ¿Con qué clase de llave quedó el canal? (#669)
 *
 * Una llave `zv_test_` **solo alcanza a los números del equipo en el
 * proveedor**. Con ella el producto parece roto —«no llegó»— cuando lo único que
 * pasa es que el ambiente está en sandbox. Y no había forma de verlo: se cambiaba
 * la variable, se desplegaba, y después había que adivinar si entró. La única
 * señal era mandar un mensaje y ver si fallaba — gastar un intento contra un
 * cliente real para averiguar una cosa de configuración.
 *
 * Dos veces en un día se perdieron horas exactamente ahí.
 *
 * Es la misma forma que #641: el arreglo no faltaba, faltaba el LUGAR donde se
 * vería.
 *
 * No publica la llave, ni un pedazo, ni el nombre de la variable: solo de qué
 * clase es, que es lo único accionable. Y NO decide el estado — una llave de
 * prueba es una decisión legítima en un ambiente de pruebas.
 */
function credencialDelCanal(): Dependencia {
  const llave = (process.env.ZAVU_API_KEY ?? '').trim();
  if (llave === '') {
    return {
      nombre: 'canal',
      ok: false,
      ms: 0,
      bloquea: false,
      detalle:
        'Sin credencial de canal en este ambiente: no se puede enviar ni recibir por ' +
        'WhatsApp. El detalle está en el diagnóstico del canal, con sesión.',
    };
  }
  // Las de sandbox se distinguen por su prefijo, que es del proveedor y no un
  // invento nuestro. Cualquier otra forma se informa como desconocida en vez de
  // afirmar que es de producción: decir «producción» de algo que no se reconoce
  // sería justamente la clase de mentira que esto viene a evitar.
  if (llave.startsWith('zv_test_')) {
    return {
      nombre: 'canal',
      ok: true,
      ms: 0,
      bloquea: false,
      detalle:
        'Credencial de PRUEBA. Solo alcanza a los números del equipo en el proveedor: ' +
        'a cualquier otro número el envío falla y la bandeja lo muestra como «no llegó».',
    };
  }
  if (llave.startsWith('zv_live_')) {
    return { nombre: 'canal', ok: true, ms: 0, bloquea: false, detalle: 'Credencial de producción.' };
  }
  return {
    nombre: 'canal',
    ok: true,
    ms: 0,
    bloquea: false,
    detalle: 'Credencial de una forma que no reconocemos: ni de prueba ni de producción.',
  };
}

function credencialesDeIa(): Dependencia {
  const con = PROVIDERS.filter((p) => providerAvailable(p)).length;
  return {
    nombre: 'ia',
    ok: con > 0,
    ms: 0,
    bloquea: false,
    detalle:
      con > 0
        ? `${con} de ${PROVIDERS.length} proveedores con credencial.`
        : 'Ningún proveedor de IA tiene credencial en este ambiente: el asistente no puede ' +
          'trabajar. El detalle, con el nombre de cada variable, está en /agents/diagnostico.',
  };
}
