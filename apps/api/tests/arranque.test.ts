import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound } from '@iaxti/module-conversations';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';
import { dbRoleResolver } from '../src/auth/role-resolver';
import { registry } from '../src/registry';

/**
 * El arranque de una conversación en una llamada (#761).
 *
 * Lo que estas pruebas cuidan es, en orden de importancia:
 *
 *  1. **Una sola transacción.** Es la forma de equivocarse que se ve bien: un
 *     arranque que llama a cada caso de uso con su propio `withTenant` agrupa
 *     las llamadas HTTP y no las transacciones. El presupuesto de llamadas se
 *     vería verde —2 en vez de 21— y la pantalla seguiría igual de lenta,
 *     porque cada `withTenant` paga `BEGIN`, `set_config` y `COMMIT`, y con la
 *     base a 64 ms de viaje (#711) eso es el 75 % del costo.
 *  2. **Degrada pieza por pieza**, y «no puedes verlo» no se confunde con «no
 *     hay».
 *  3. **Las rutas sueltas siguen funcionando**: el arranque se agrega, no
 *     reemplaza.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let contado: Pool;
let tenant: string;
let conversationId: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();
const vendedor = randomUUID();

/**
 * Cuántos clientes se retiraron del pool desde la última vez que se puso en cero.
 *
 * Empezó contando `BEGIN`, y eso era CIEGO a la mitad del problema: una pieza
 * que use `pool.query(...)` en vez del cliente de la transacción no abre
 * ninguna transacción —así que el contador seguía en 1— y sin embargo pide su
 * propia conexión y paga su propio viaje. Pasaba de verdad: el acceso por plan
 * llamaba `modulosVendibles(pool())` y se llevaba dos conexiones mientras el
 * `withTenant` ya retenía una, con el pool en 6.
 *
 * Contar retiros del pool cubre las dos cosas, porque toda transacción empieza
 * por retirar un cliente y todo `pool.query` también. Un arranque = un retiro.
 */
let retiros = 0;

/**
 * Un pool que cuenta transacciones.
 *
 * No mide tiempo, a propósito: medir milisegundos en esta máquina sería medir
 * la máquina (es lo que se cayó tres veces en #587). Cuenta `BEGIN`, que es una
 * propiedad de la FORMA del código y no de la carga del momento.
 */
function poolQueCuenta(real: Pool): Pool {
  return new Proxy(real, {
    get(destino, prop, receptor) {
      if (prop === 'connect') {
        /**
         * `connect` tiene DOS formas y hay que honrar las dos.
         *
         * Esta envoltura empezó siendo solo `async () => …`, y con eso el
         * arranque del shell se quedaba colgado para siempre — cuarenta
         * segundos y seguía. El motivo: `pool.query()` de `pg` no usa la forma
         * de promesa, llama `this.connect((err, client, release) => …)` con
         * CALLBACK. Al ignorar el argumento, el callback no se llamaba nunca y
         * cualquier `pool.query` quedaba esperando a nadie.
         *
         * O sea que la prueba no medía el arranque: medía su propio arnés. Y el
         * modo de falla era el peor posible —un cuelgue sin mensaje— que manda
         * a buscar un deadlock en el código que se está probando.
         */
        return (cb?: (err: Error | undefined, cliente?: PoolClient, liberar?: () => void) => void) => {
          retiros += 1;
          if (typeof cb === 'function') {
            return (destino.connect as (c: typeof cb) => void)(cb);
          }
          return destino.connect();
        };
      }
      return Reflect.get(destino, prop, receptor);
    },
  });
}

async function pedir(quien: string, path: string): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('test-arranque', 'crece') RETURNING id",
  );
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'duena@arranque.cl', 'ADMIN'],
    [vendedor, 'vende@arranque.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56944440077',
      channel: 'simulador',
      body: 'hola, ¿precios?',
    }),
  );
  conversationId = res.conversation.id;

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);

  contado = poolQueCuenta(createPool(ADMIN_URL));
  usarPool(contado);
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  usarPool(null);
  for (const tabla of ['messages', 'conversations', 'contacts', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await contado.end();
  await admin.end();
});

describe('arranque de una conversación (#761)', () => {
  it('arma TODO en una sola transacción', async () => {
    retiros = 0;
    const res = await pedir(duena, `/conversations/${conversationId}/arranque`);
    expect(res.status).toBe(200);

    /**
     * Uno. No «pocos»: uno.
     *
     * Si esto empieza a dar 12, alguien le puso su propio `withTenant` —o un
     * `pool.query`— a una pieza, y el arranque dejó de ser un arranque: son 11
     * conexiones y 33 statements de más, o sea ~2 s con la base lejos.
     */
    expect(retiros, 'el arranque tiene que retirar UN cliente del pool, no uno por pieza').toBe(1);
  });

  it('el urgente trae SOLO lo urgente, y la conversación no es una pieza que degrada', async () => {
    const res = await pedir(duena, `/conversations/${conversationId}/arranque`);
    const cuerpo = await res.json();

    // La conversación va derecho: si no existe o no es tuya, esto es un 404.
    expect(cuerpo.conversacion.id).toBe(conversationId);
    expect(cuerpo.conversacion).toHaveProperty('ventanaAbierta');
    expect(cuerpo.conversacion).toHaveProperty('cierraA');
    /**
     * Los límites vienen con la MISMA forma que su ruta suelta: `{canal,
     * limites}`.
     *
     * Mi primera versión de esta prueba afirmaba `Array.isArray(...)`, o sea
     * congelaba la forma equivocada — el arranque devolvía el arreglo pelado y
     * el chat hace `limitesDeAdjunto?.limites.flatMap(…)`. Un arreglo es
     * truthy, así que el `?.` no corta y `.flatMap` lanza DURANTE el render: la
     * bandeja se caía al abrir cualquier conversación.
     *
     * Se compara contra la ruta suelta y no contra una forma escrita a mano:
     * una prueba que repite la forma nueva no puede cazar que se separó de la
     * vieja.
     */
    const sueltos = await (await pedir(duena, `/conversations/${conversationId}/attachments/limites`)).json();
    expect(cuerpo.limitesDeAdjunto).toEqual(sueltos);
    expect(cuerpo.limitesDeAdjunto.canal).toBeTruthy();
    expect(Array.isArray(cuerpo.limitesDeAdjunto.limites)).toBe(true);
    expect(cuerpo.mensajes.estado).toBe('ok');
    expect(cuerpo.mensajes.dato.length).toBeGreaterThan(0);

    /**
     * Y NADA más: las claves son EXACTAMENTE estas tres.
     *
     * Esto es la mitad de #690 que #761 casi deshace: la pantalla espera este
     * arranque, así que cualquier pieza que pueda tardar —el copiloto vivía en
     * ese camino y una vez pasó de 2 s a 170 s— lo convierte en el techo de
     * todo lo demás.
     *
     * Se comparan las claves exactas y no una lista de prohibidas: con una lista
     * negra, la pieza nueva que alguien agregue mañana no está en ella y pasa
     * sola. Lo que hay que forzar es que agregar algo acá sea una DECISIÓN —
     * tocar esta prueba y escribir por qué esa pieza no puede tardar.
     */
    expect(Object.keys(cuerpo).sort()).toEqual(['conversacion', 'limitesDeAdjunto', 'mensajes']);
  });

  it('la ficha trae el resto, cada pieza con su estado', async () => {
    const res = await pedir(duena, `/conversations/${conversationId}/arranque/ficha`);
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    /**
     * Siete, y exactamente siete.
     *
     * Las cuatro de la ficha estuvieron fuera un rato porque ningún componente
     * las leía —y un agregado que trae lo que nadie lee es el mismo trabajo
     * cobrado en el peor momento—. Volvieron cuando la bandeja empezó a bajarlas
     * por props a `FichaContacto` y `SecuenciasFicha`, que antes las pedían por
     * su cuenta: cuatro puertas más por conversación abierta, medidas en el e2e.
     *
     * Claves EXACTAS a propósito: si alguien agrega una pieza que nadie lee,
     * esto se pone rojo y le toca enseñar quién la consume.
     */
    expect(Object.keys(cuerpo).sort()).toEqual([
      'analisis',
      'contacto',
      'etiquetasDelContacto',
      'inscripciones',
      'notas',
      'secuencias',
      'sugerencia',
    ]);
    for (const pieza of ['notas', 'sugerencia', 'analisis', 'contacto', 'secuencias']) {
      expect(['ok', 'sin-permiso', 'modulo-apagado']).toContain(cuerpo[pieza].estado);
    }

    /**
     * Y `analisis` viene PLANO y con `marcaManual`, igual que su ruta suelta.
     *
     * Lo primero que escribí lo anidaba y lo renombraba (`{analisis, modo}`) y
     * perdía `marcaManual` — el dato de #697 que dice quién puso el piloto
     * automático, que es la decisión más delicada del producto. La ficha lee
     * `analisis.acciones.length` y reventaba.
     */
    if (cuerpo.analisis.estado === 'ok') {
      const suelto = await (await pedir(duena, `/conversations/${conversationId}/analisis`)).json();
      expect(cuerpo.analisis.dato).toEqual(suelto);
      expect(cuerpo.analisis.dato).toHaveProperty('mode');
      expect(cuerpo.analisis.dato).toHaveProperty('marcaManual');
      expect(cuerpo.analisis.dato).toHaveProperty('acciones');
    }
  });

  it('la ficha también arma todo en una sola transacción', async () => {
    retiros = 0;
    const res = await pedir(duena, `/conversations/${conversationId}/arranque/ficha`);
    expect(res.status).toBe(200);
    expect(retiros, 'la ficha tiene que retirar UN cliente del pool').toBe(1);
  });

  /**
   * Medido antes de escribir la aserción: un USER tiene **todos** los permisos
   * de las piezas de una conversación —mensajes, notas, sugerencia, análisis,
   * ficha, etiquetas, secuencias— y es correcto que los tenga: esa pantalla es
   * la herramienta del vendedor.
   *
   * Así que la degradación por PERMISO se comprueba donde de verdad ocurre: en
   * el arranque del shell, donde `retencion` es de `tenant.settings` y un USER
   * no la tiene. Acá se comprueba la otra mitad, que no tenía ninguna prueba:
   * el MÓDULO apagado.
   *
   * Escribir «las notas vienen sin-permiso» porque suena plausible habría
   * dejado una prueba verde afirmando algo falso sobre los roles.
   */
  it('un rol angosto recibe las piezas de la conversación: todas son suyas', async () => {
    const res = await pedir(vendedor, `/conversations/${conversationId}/arranque/ficha`);
    expect(res.status, 'un rol angosto no puede recibir un 403 global').toBe(200);
    const cuerpo = await res.json();
    for (const pieza of ['notas', 'sugerencia', 'analisis']) {
      expect(cuerpo[pieza].estado, `un USER debería poder ver ${pieza}`).toBe('ok');
    }
  });

  it('un módulo apagado no tumba el arranque: esa pieza viene dicha', async () => {
    // Criterio 3 de #761: un despliegue sin copiloto tiene que poder abrir una
    // conversación, y la pantalla tiene que saber que la pieza NO EXISTE en vez
    // de dibujar «no hay sugerencias» — que es lo que leería un `null`.
    registry.disable('agents');
    try {
      const ficha = await pedir(duena, `/conversations/${conversationId}/arranque/ficha`);
      expect(ficha.status).toBe(200);
      const cuerpo = await ficha.json();
      expect(cuerpo.sugerencia).toEqual({ estado: 'modulo-apagado', modulo: 'agents' });
      expect(cuerpo.analisis).toEqual({ estado: 'modulo-apagado', modulo: 'agents' });
      // Y lo que no depende de `agents` llega igual.
      expect(cuerpo.notas.estado).toBe('ok');
      const urgente = await pedir(duena, `/conversations/${conversationId}/arranque`);
      expect((await urgente.json()).conversacion.id).toBe(conversationId);
    } finally {
      registry.enable('agents');
    }
  });

  /**
   * Un rol propio del negocio (#73) tiene que recibir sus piezas.
   *
   * Esto empezó con `actorCan`, que es síncrono y por eso no puede resolver un
   * rol custom —sus permisos viven en la base—: devolvía `false` para todos, así
   * que el arranque entero volvía `sin-permiso` pieza por pieza y la pantalla lo
   * dibujaba como «no puedes verlo». Sin candados de plan, sin avisos, sin
   * atajos, y con el aviso de modo soporte APAGADO, que es un aviso de
   * privacidad.
   */
  it('un rol propio del negocio no recibe «sin-permiso» en todo (#73)', async () => {
    const rol = await admin.query(
      `INSERT INTO roles (tenant_id, name, permissions)
       VALUES ($1, 'Recepción', $2::jsonb) RETURNING name`,
      [tenant, JSON.stringify(['conversations.read', 'conversations.notes', 'tenant.read'])],
    );
    const recepcion = randomUUID();
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email: 'recepcion@arranque.cl', roleName: rol.rows[0].name }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: recepcion }));

    const res = await pedir(recepcion, `/conversations/${conversationId}/arranque/ficha`);
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    // Lo que su rol SÍ incluye.
    expect(cuerpo.notas.estado, 'un rol custom con conversations.notes tiene que ver las notas').toBe('ok');
    // Y lo que no: `agents.use` no está en su lista, así que la sugerencia viene
    // dicha como sin-permiso — eso es correcto y es distinto de «todo apagado».
    expect(cuerpo.sugerencia).toEqual({ estado: 'sin-permiso' });
  });

  it('«no puedes verlo» no se confunde con «no hay»', async () => {
    const res = await pedir(duena, `/conversations/${conversationId}/arranque/ficha`);
    const cuerpo = await res.json();
    // La dueña SÍ puede ver la sugerencia, y no hay ninguna vigente: eso es
    // `ok` con el dato en null, que es distinto de `sin-permiso`.
    expect(cuerpo.sugerencia.estado).toBe('ok');
    expect(cuerpo.sugerencia.dato.sugerencia).toBeNull();
    expect(cuerpo.sugerencia.dato.motivo).toBeTruthy();
  });

  /**
   * Una pieza que se cae no se lleva el arranque.
   *
   * Es la otra mitad de lo que agrupar no puede hacer: un solo `await` ataba la
   * pantalla a la pieza más LENTA (#690), y un `Promise.all` sin `catch` por
   * pieza la ata a la más DÉBIL — un hipo de la base en una pieza dejaba la
   * conversación sin abrir. Antes no pasaba porque cada llamada tenía su propio
   * `.catch` en el front.
   *
   * Se rompe la pieza de notas desde la BASE —renombrando su tabla un instante—
   * y no con un mock, porque lo que hay que comprobar es que el endpoint
   * sobrevive a una falla de verdad.
   *
   * ## Y acá quedó medido algo que el `catch` por pieza NO arregla
   *
   * Cuando lo que falla es una CONSULTA, Postgres deja la transacción abortada
   * y todo statement siguiente responde «current transaction is aborted». Las
   * piezas comparten transacción —de ahí viene toda la ganancia de #761—, así
   * que una consulta caída se lleva a las demás por mucho `catch` que haya.
   * Esta prueba lo fija como lo que es, no como lo que me habría gustado:
   * `sugerencia` y `analisis` también vuelven `falla`.
   *
   * Lo que el `catch` sí cambia: **200 con cada pieza marcada** en vez de un 500
   * opaco. Con el 500, la pantalla no puede distinguir «se cayó una pieza» de
   * «no existe la conversación»; con esto puede decir qué no cargó y recargarlo
   * por su ruta suelta, que se quedó para esto.
   */
  it('una pieza que se cae no da 500: el arranque contesta con las piezas marcadas (#761)', async () => {
    await admin.query('ALTER TABLE internal_notes RENAME TO internal_notes_escondida');
    try {
      const res = await pedir(duena, `/conversations/${conversationId}/arranque/ficha`);
      expect(res.status, 'una pieza caída no puede dar 500 en todo el arranque').toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.notas).toEqual({ estado: 'falla' });
      // `falla` no se disfraza de «no hay»: la pantalla tiene que poder decir
      // «esto no cargó» en vez de «no hay notas».
      expect(cuerpo.notas).not.toHaveProperty('dato');
      // Y las otras TAMBIÉN caen, porque comparten la transacción envenenada.
      // Está escrito así a propósito: el día que alguien agregue SAVEPOINT por
      // pieza, esta prueba se pone roja y le toca decidir si vale pagar dos
      // statements por pieza en cada arranque.
      expect(cuerpo.sugerencia.estado).toBe('falla');
      expect(cuerpo.analisis.estado).toBe('falla');
      expect(cuerpo.contacto.estado).toBe('falla');
    } finally {
      await admin.query('ALTER TABLE internal_notes_escondida RENAME TO internal_notes');
    }
  });

  it('y el arranque URGENTE sobrevive a eso: el hilo se puede leer igual', async () => {
    // Lo urgente no toca `internal_notes`, así que la falla de la ficha no lo
    // alcanza. Es la razón de haberlos partido en dos endpoints y no solo en dos
    // llamadas: una transacción envenenada no cruza de uno al otro.
    await admin.query('ALTER TABLE internal_notes RENAME TO internal_notes_escondida');
    try {
      const res = await pedir(duena, `/conversations/${conversationId}/arranque`);
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.conversacion.id).toBe(conversationId);
      expect(cuerpo.mensajes.estado).toBe('ok');
    } finally {
      await admin.query('ALTER TABLE internal_notes_escondida RENAME TO internal_notes');
    }
  });

  it('una conversación que no existe es 404, no un arranque con piezas vacías', async () => {
    const res = await pedir(duena, `/conversations/${randomUUID()}/arranque`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('el arranque del shell también arma todo en una transacción', async () => {
    retiros = 0;
    const res = await pedir(duena, '/arranque');
    expect(res.status).toBe(200);
    /**
     * Acá es donde el contador de `BEGIN` era ciego: `modulosVendibles(pool())`
     * no abría transacción —seguía dando 1— y se llevaba dos conexiones más
     * mientras el `withTenant` retenía una, con el pool en 6. Contar retiros lo
     * ve.
     */
    expect(retiros, 'el arranque del shell tiene que retirar UN cliente del pool').toBe(1);

    const cuerpo = await res.json();
    /**
     * `me` NO está acá, y es a propósito. Lo tuve y lo saqué: `tenantsOf`
     * consulta `user_roles`, que tiene RLS, y dentro de esta transacción
     * `app.tenant_id` está fijado — la lista de negocios volvía con UNO, el que
     * ya estás mirando. Un dato recortado es peor que uno ausente porque nadie
     * lo va a dudar. Y con `X-Api-Key` el actor es `apikey:<uuid>`, que no entra
     * en una columna uuid: el arranque entero daba 500.
     */
    expect(cuerpo).not.toHaveProperty('me');
    /**
     * Y el estado del soporte TAMPOCO, por una regla que vale escribir: una
     * pieza que tiene que estar FRESCA no entra en un agregado que se pide una
     * vez. El arranque no se vuelve a pedir, así que el soporte que entra diez
     * minutos después no aparecería nunca — peor que el TTL de dos minutos que
     * #711 rechazó justamente por esto. Lo cazó el e2e de #68.
     */
    expect(cuerpo).not.toHaveProperty('soporte');
    // El catálogo del DESPLIEGUE sale del registry: no consulta nada y es el
    // mismo para todos (#629).
    expect(Array.isArray(cuerpo.modulos)).toBe(true);
    for (const p of ['acceso', 'avisos', 'respuestasRapidas', 'etiquetas', 'campos', 'empresas', 'retencion']) {
      expect(cuerpo[p], `falta la pieza ${p}`).toBeTruthy();
      expect(['ok', 'sin-permiso', 'modulo-apagado']).toContain(cuerpo[p].estado);
    }
  });

  it('en el shell, un USER tampoco recibe un 403 global', async () => {
    const res = await pedir(vendedor, '/arranque');
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.etiquetas.estado).toBe('ok');
    expect(cuerpo.retencion).toEqual({ estado: 'sin-permiso' });
  });

  it('las rutas sueltas siguen funcionando: el arranque se AGREGA', async () => {
    // Quien recarga UNA cosa —las notas después de escribir una— no tiene por
    // qué volver a pedir los mensajes, la ficha y las secuencias.
    for (const ruta of [
      `/conversations/${conversationId}`,
      `/conversations/${conversationId}/messages`,
      `/conversations/${conversationId}/notes`,
      `/conversations/${conversationId}/suggestion`,
      '/tags',
      '/campos',
      '/me',
      '/me/modules/acceso',
      '/support-status',
      '/quick-replies',
    ]) {
      expect((await pedir(duena, ruta)).status, `se rompió ${ruta}`).toBe(200);
    }
  });
});
