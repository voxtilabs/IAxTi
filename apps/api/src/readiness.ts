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
export const TIMEOUT_MS = 2000;

/**
 * La sonda de salida tiene su propio tope, y más largo que el de la base (#852).
 *
 * Compartían los 2 s, y eso rompía justo lo que la sonda viene a hacer. Un
 * arranque en frío hace tardar a las DOS por el mismo motivo —el contenedor
 * recién levantado—, así que las dos agotaban el tope juntas y salía la
 * lectura «443 no + 6543 no», que es «el contenedor no tiene salida»: la más
 * alarmante de las tres y la que manda a mirar la red del VPS, el firewall y
 * Cloudflare. Medido en staging: `ms: 2003`, y veinte segundos después todo en
 * verde. No había nada roto.
 *
 * El trabajo de esta sonda es DISTINGUIR, y para distinguir necesita
 * completarse: cortarla al mismo tiempo que la base la deja sin respuesta
 * precisamente cuando más se la necesita.
 *
 * ## Por qué CINCO y no otro número
 *
 * Decía acá que «es lo que el pool de Postgres se da a sí mismo», y esa
 * paridad no la sostiene nadie: el tope del pool sale de
 * `DB_CONNECT_TIMEOUT_MS` (packages/db/src/client.ts:32-42), que es una
 * variable de entorno que alguien puede mover mañana sin enterarse de que acá
 * hay un número que decía copiarla. Coincidir con un 5000 que está en otro
 * paquete, que mide otra cosa —conseguir una conexión TCP+TLS a Postgres, no
 * un GET por 443— y que es configurable, no es una razón: es un parecido.
 *
 * La razón propia: tiene que alcanzar para un handshake TLS completo desde un
 * contenedor que acaba de levantarse (DNS sin caché + TCP + TLS contra
 * Supabase), y tiene que caber holgado en los 10 s de `periodSeconds` de la
 * readinessProbe del chart para que una sonda no se solape con la siguiente.
 * Entre esos dos bordes, 5 s es el lugar cómodo.
 *
 * ## Lo que cuesta
 *
 * En rojo, `/ready` puede tardar hasta 7 s en vez de 4 (la base agota sus 2 s
 * y después ésta los suyos), y se paga solo en el camino que ya falló: en
 * verde no se llama a nadie.
 *
 * Quien lo paga NO es Kubernetes. `infra/helm/iaxti/templates/deployments.yaml:63-66`
 * no fija `timeoutSeconds`, así que rige el defecto de Kubernetes —1 s— y la
 * probe ya se rendía mucho antes de los 4 s: para el orquestador esto no
 * cambia nada, ni para bien ni para mal. Lo paga la persona que hace `curl
 * /ready` para entender qué pasa, y es la que quiere la respuesta completa.
 *
 * Si alguien lo vuelve a igualar a TIMEOUT_MS, vuelve el falso «no tiene
 * salida» en cada arranque en frío. Eso lo cuida una prueba sobre estas dos
 * constantes, que por eso se exportan.
 */
export const TIMEOUT_SALIDA_MS = 5000;

/**
 * Hasta cuándo «recién levantado» explica una lentitud (#852).
 *
 * El criterio 3 del issue pide usar la señal de arranque para no publicar un
 * diagnóstico de red con el contenedor recién encendido. En `/ready` de la API
 * no hay un campo `startup` que mirar —ese vive en el readiness de los
 * workers, `packages/core/src/consumer-readiness.ts:75`, y lo alimenta el
 * arranque de BullMQ—, así que acá la señal es `process.uptime()`, que
 * contesta la misma pregunta sin inventar un estado nuevo que mantener.
 *
 * Un minuto, y es a propósito más que de sobra: la probe pega la primera vez a
 * los 5 s y después cada 10 (chart, `deployments.yaml:63-66`), y el caso del
 * issue estaba verde veinte segundos después. Pasado el minuto, «acaba de
 * arrancar» deja de explicar nada y se vuelve una excusa.
 *
 * Los dos errores no cuestan igual: de más, se calla un corte real durante el
 * primer minuto de vida del pod —y a los 60 s lo grita—; de menos, se grita
 * «el contenedor no tiene salida» en cada despliegue, que es el bug.
 */
const VENTANA_DE_ARRANQUE_MS = 60_000;

/**
 * Ajustes de la sonda. En producción NO los pasa nadie.
 *
 * El controlador llama `checkReadiness(apiPool(), 'api')` y se lleva los
 * valores de arriba (`app.module.ts:124`). Existen por dos cosas que las
 * pruebas no pueden conseguir de otra forma:
 *
 *  · Los topes, para poder ejercitar la RELACIÓN entre los dos —que es lo que
 *    falló— sin gastar siete segundos de reloj real por caso. Con los números
 *    de fábrica, este archivo solo se llevaba quince segundos del paquete y
 *    dejaba sin CPU a las pruebas de los demás, que se caen por su propio tope
 *    de 5 s. Los números de fábrica los fija su propia prueba, que es barata.
 *
 *  · El uptime, porque si no lo decide cuánto hace que arrancó el worker de
 *    vitest: la misma prueba daría «arrancando» a los 3 s de vida del worker y
 *    «levantado hace rato» al minuto. Una prueba que cambia de resultado según
 *    el momento en que le toca correr no prueba nada.
 */
export interface OpcionesDeSonda {
  topeMs?: number;
  topeDeSalidaMs?: number;
  ventanaDeArranqueMs?: number;
  /** Por omisión, `process.uptime()`. */
  levantadoHaceMs?: number;
}

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

async function medir(
  nombre: string,
  fn: () => Promise<unknown>,
  topeMs = TIMEOUT_MS,
): Promise<Dependencia> {
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
        setTimeout(() => reject(new Error(`no respondió en ${topeMs} ms`)), topeMs).unref?.(),
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
 * Hace cuánto, en algo que se lee de un vistazo.
 *
 * Va en el detalle que lee una persona a las tres de la mañana: «14 min» se
 * entiende sin dividir, «840000 ms» no.
 */
function haceCuanto(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/**
 * El motivo de red, desenterrado de donde `undici` lo deja.
 *
 * MEDIDO en este Node (v22.22), que es lo que corre en el contenedor:
 *
 *   fetch('http://127.0.0.1:9999/x')
 *     → name: 'TypeError', message: 'fetch failed'
 *       cause: { message: 'connect ECONNREFUSED 127.0.0.1:9999', code: 'ECONNREFUSED' }
 *
 * O sea que `err.message` NO es el motivo: es la tapa. Publicarlo —que es lo
 * que se hacía— dejaba «sale a internet: NO (fetch failed)», que es
 * exactamente el detalle que no dice nada que #241 vino a cerrar, con la
 * agravante de sonar a conclusión. Y cuando el host resuelve a varias
 * direcciones, undici junta los intentos en un `AggregateError` y el motivo
 * baja un piso más, a `cause.errors[0]`.
 *
 * Se publica el CÓDIGO y no el mensaje a propósito: el código es la parte
 * accionable —`ENOTFOUND` es DNS, `ECONNREFUSED` es que no hay nadie
 * escuchando, `EHOSTUNREACH` es ruteo— y el mensaje trae pegada la IP a la
 * que estamos marcando. Misma regla que `puertoDeLaBase()` acá abajo: un
 * diagnóstico no justifica publicar a dónde nos conectamos.
 */
function motivoDeRed(err: unknown): string {
  const vistos = new Set<unknown>();
  let actual: unknown = err;
  let codigo: string | undefined;
  let mensaje: string | undefined;
  while (actual && typeof actual === 'object' && !vistos.has(actual)) {
    vistos.add(actual);
    const e = actual as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.code === 'string' && e.code !== '') codigo = e.code;
    if (typeof e.message === 'string' && e.message !== '' && e.message !== 'fetch failed') {
      mensaje = e.message;
    }
    // Primero el AggregateError de las varias direcciones, después la tapa.
    actual = Array.isArray(e.errors) && e.errors.length > 0 ? e.errors[0] : e.cause;
  }
  return codigo ?? mensaje?.slice(0, 60) ?? 'sin motivo';
}

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
 * ## La tercera lectura, y por qué NO es «todo timeout es no concluyente» (#852)
 *
 * El issue pedía que un tope agotado dejara de reportarse como «NO». Hecho,
 * pero no para cualquier tope agotado, y el matiz es la mitad del arreglo.
 *
 * Medido en este Node: un corte de red de los comunes —el firewall que
 * descarta los paquetes en vez de rechazarlos, que es EXACTAMENTE el
 * incidente que este módulo nombra como fundador (#241: «los paquetes no
 * llegaban a Supabase»)— no da `ECONNREFUSED`: da silencio hasta que lo corta
 * nuestro propio tope, o sea `AbortError`. Si todo `AbortError` fuera «no se
 * pudo comprobar», el corte que motivó todo esto pasaría a reportarse como un
 * encogimiento de hombros. Habríamos cambiado un ruido por un silencio, que
 * no es mejor: es el mismo error con otro signo.
 *
 * Lo que de verdad separa «arranque en frío» de «corte» no es el error, que
 * es el mismo: es hace cuánto que el proceso está vivo. Por eso el criterio 3
 * del issue —usar la señal de arranque— no es un adorno, es lo que hace
 * posible el criterio 1 sin romper #241:
 *
 *   443 sin respuesta + proceso recién levantado → no se pudo comprobar
 *   443 sin respuesta + proceso levantado hace rato → NO, y con el uptime
 *     a la vista para que se pueda discutir
 *
 * Solo corre cuando Postgres YA falló: en verde no se le hace ni una llamada
 * a nadie. Y NO decide la salud — una sonda de diagnóstico que tumbe el
 * servicio sería peor que el problema que viene a explicar.
 */
async function salidaAInternet(
  topeMs: number,
  arrancando: boolean,
  levantadoHaceMs: number,
): Promise<string | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const inicio = Date.now();
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), topeMs);
  try {
    await fetch(`${base.replace(/\/$/, '')}/auth/v1/health`, {
      method: 'GET',
      signal: control.signal,
    });
    return `sale a internet: sí (Supabase por 443 en ${Date.now() - inicio} ms)`;
  } catch (err) {
    // Se mira el `signal` y no el nombre del error: «lo cortamos nosotros» es
    // un hecho que conocemos sin tener que adivinarlo del `err` que nos
    // devuelvan. Cualquier otro fallo llega con la pila de red todavía
    // hablando, y eso sí concluye.
    if (control.signal.aborted) {
      if (arrancando) {
        // El caso del issue: `ms: 2003` y todo verde veinte segundos después.
        // Las dos sondas tardan por lo mismo —el contenedor acaba de
        // levantarse—, así que el 443 mudo no distingue nada y decir «no
        // tiene salida» sería inventar la conclusión más alarmante de las
        // tres. No concluir NO es afirmar que hay salida: el fallo de
        // postgres sigue siendo un fallo y `/ready` sigue devolviendo 503;
        // lo único que se retira es la parte que no se ganó.
        return (
          `sale a internet: no se pudo comprobar (443 tampoco contestó en ${topeMs} ms, ` +
          'y con el proceso recién levantado eso no distingue un corte de un arranque en frío)'
        );
      }
      // Levantado hace rato y 443 mudo: «acaba de arrancar» ya no explica
      // nada, y esto es la firma del corte de #241. Va como NO, que es el
      // aviso que hace falta, pero con el uptime adentro para que quien lo
      // lea pueda estar en desacuerdo con el razonamiento y no solo con la
      // conclusión.
      return (
        `sale a internet: NO (443 no contestó en ${topeMs} ms y el proceso lleva ` +
        `${haceCuanto(levantadoHaceMs)} levantado: no es un arranque en frío)`
      );
    }
    return `sale a internet: NO (${motivoDeRed(err)})`;
  } finally {
    clearTimeout(corte);
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

export async function checkReadiness(
  pool: Pool | null,
  service = 'api',
  opciones: OpcionesDeSonda = {},
): Promise<Readiness> {
  const topeMs = opciones.topeMs ?? TIMEOUT_MS;
  const topeDeSalidaMs = opciones.topeDeSalidaMs ?? TIMEOUT_SALIDA_MS;
  const levantadoHaceMs = opciones.levantadoHaceMs ?? process.uptime() * 1000;
  const arrancando = levantadoHaceMs < (opciones.ventanaDeArranqueMs ?? VENTANA_DE_ARRANQUE_MS);
  const dependencias: Dependencia[] = [];

  if (pool) {
    const sonda = await medir('postgres', () => pool.query('SELECT 1'), topeMs);
    if (sonda.ok) {
      dependencias.push(sonda);
    } else {
      // En rojo, las tres cosas que hacen falta para saber a quién llamar: a
      // qué puerto intentó, si el contenedor sale a internet siquiera, y
      // —criterio 3 de #852— si todo esto está pasando con el proceso recién
      // encendido. Esa última va suelta y no pegada al diagnóstico de red
      // porque vale igual cuando no hay sonda de salida que publicar: «la
      // base no contesta» y «la base no contesta y el proceso tiene tres
      // segundos de vida» mandan a hacer cosas distintas, y la segunda es
      // casi siempre «esperá y volvé a pedir». Que es, literalmente, lo que
      // el issue cuenta que pasó: veinte segundos después estaba todo verde.
      const puerto = puertoDeLaBase();
      const salida = await salidaAInternet(topeDeSalidaMs, arrancando, levantadoHaceMs);
      const partes = [
        sonda.detalle ?? 'no conecta',
        puerto ? `puerto ${puerto}` : null,
        arrancando
          ? `el proceso lleva ${haceCuanto(levantadoHaceMs)} levantado: todavía está arrancando`
          : null,
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
    dependencias.push(await medir('redis', () => redisSonda!.ping(), topeMs));
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
