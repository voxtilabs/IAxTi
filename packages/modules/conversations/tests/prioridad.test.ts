import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { cambiarPrioridad } from '../application/conversations';
import { listInbox } from '../application/inbox';

/**
 * La prioridad se usa (#550).
 *
 * `conversations.priority` existía desde la primera migración con su CHECK
 * completo, estaba en el SPEC, estaba en el tipo y **la API la devolvía en cada
 * conversación de la bandeja**. Cero escrituras, cero pantallas, cero filtros,
 * cero ordenamientos: siempre `'normal'`.
 *
 * Era peor que si no existiera: el campo viajaba en la respuesta, así que quien
 * consumiera la API dibujaba un selector o una insignia que el backend nunca iba
 * a poder cambiar.
 *
 * Lo que estas pruebas cuidan es lo que el issue pide con todas las letras: que
 * **el orden respete la prioridad**, no solo que el campo se guarde. Un campo
 * que se guarda y no ordena es exactamente el estado del que venimos.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
// Cada conversación trae su propio contacto: `contacts` tiene índice único por
// (tenant, teléfono), así que reusar uno haría que la segunda inserción choque.
let telefono = 56_955_200_000;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query("INSERT INTO tenants (name) VALUES ('prioridad-bandeja') RETURNING id")
  ).rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

/**
 * Una conversación con su antigüedad y su prioridad.
 *
 * `hace` en minutos: lo que decide el orden POR DEFECTO es la actividad, así que
 * para probar que la prioridad va delante hay que poner a la urgente como la MÁS
 * VIEJA. Si la urgente fuera también la más reciente, la prueba pasaría sin que
 * la prioridad ordenara nada.
 */
async function conversacion(
  prioridad: 'baja' | 'normal' | 'alta' | 'urgente',
  haceMinutos: number,
): Promise<string> {
  telefono += 1;
  const c = (
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin)
       VALUES ($1, $2, $3, 'whatsapp') RETURNING id`,
      [tenant, `C-${prioridad}-${haceMinutos}`, `+${telefono}`],
    )
  ).rows[0].id;
  const r = await admin.query(
    `INSERT INTO conversations
       (tenant_id, contact_id, channel, state, priority, created_at,
        last_inbound_at, last_message_at)
     VALUES ($1, $2, 'whatsapp', 'open', $3,
             now() - make_interval(mins => $4 + 10),
             now() - make_interval(mins => $4),
             now() - make_interval(mins => $4))
     RETURNING id`,
    [tenant, c, prioridad, haceMinutos],
  );
  return r.rows[0].id;
}

const bandeja = (filtros = {}) =>
  withTenant(admin, tenant, (c) => listInbox(c, tenant, { limit: 50, ...filtros }));

describe('el ORDEN respeta la prioridad, no solo el campo (#550)', () => {
  let urgenteVieja: string;
  let altaVieja: string;
  let normalNueva: string;
  let bajaNueva: string;

  beforeAll(async () => {
    // La urgente es la MÁS VIEJA y la baja la MÁS NUEVA: por actividad irían al
    // revés, así que el orden solo puede salir de la prioridad.
    urgenteVieja = await conversacion('urgente', 600);
    altaVieja = await conversacion('alta', 500);
    normalNueva = await conversacion('normal', 20);
    bajaNueva = await conversacion('baja', 5);
  });

  it('lo urgente va primero aunque sea lo más viejo', async () => {
    const { items } = await bandeja();
    const ids = items.map((i) => i.id);
    expect(ids[0], 'la urgente, aunque lleve diez horas sin actividad').toBe(urgenteVieja);
    expect(ids.indexOf(altaVieja)).toBeLessThan(ids.indexOf(normalNueva));
    expect(ids.indexOf(normalNueva)).toBeLessThan(ids.indexOf(bajaNueva));
  });

  it('dentro de la misma prioridad manda la actividad, como siempre', async () => {
    const vieja = await conversacion('alta', 400);
    const nueva = await conversacion('alta', 30);
    const ids = (await bandeja()).items.map((i) => i.id);
    expect(ids.indexOf(nueva), 'la más reciente primero, dentro de «alta»').toBeLessThan(
      ids.indexOf(vieja),
    );
  });

  it('también en «sin responder»: una urgente que espera 20 min pesa más que una normal de 2 h', async () => {
    // Es la vista donde se decide a quién se atiende AHORA, así que es donde la
    // prioridad tiene que mandar. El orden por defecto de esta vista es la que
    // más espera primero, o sea el contrario — si la prioridad no fuera
    // adelante, la normal de dos horas iría arriba.
    const { items } = await bandeja({ view: 'sin_responder' });
    const ids = items.map((i) => i.id);
    expect(ids.indexOf(urgenteVieja)).toBeLessThan(ids.indexOf(normalNueva));
  });

  it('se puede filtrar por prioridad', async () => {
    const { items } = await bandeja({ prioridad: 'urgente' });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.priority === 'urgente')).toBe(true);
  });

  it('la paginación no se salta ni repite al cruzar de prioridad', async () => {
    // Ésta es la que importa del cursor. El keyset tiene que comparar las
    // MISMAS columnas que el ORDER BY: con el cursor de dos valores que había
    // antes, la segunda página empezaba desde una fecha sin mirar el rango y se
    // saltaban urgentes. En una lista paginada eso no se nota mirando — se nota
    // cuando alguien no fue atendido.
    const vistas: string[] = [];
    let cursor: string | null = null;
    for (let pagina = 0; pagina < 10; pagina += 1) {
      const r: { items: Array<{ id: string }>; nextCursor: string | null } = await bandeja({
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      vistas.push(...r.items.map((i) => i.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    const completa = (await bandeja()).items.map((i) => i.id);
    expect(new Set(vistas).size, 'ninguna repetida').toBe(vistas.length);
    expect(vistas, 'las mismas y en el mismo orden que sin paginar').toEqual(completa);
  });

  it('un cursor viejo de dos valores se rechaza con un mensaje que se entiende', async () => {
    // Una pestaña abierta durante el despliegue. Se vuelve a la primera página.
    const viejo = Buffer.from(`${new Date().toISOString()}|${randomUUID()}`).toString('base64url');
    await expect(bandeja({ cursor: viejo })).rejects.toThrow(/Vuelve a la primera página/);
  });
});

describe('cambiar la prioridad (#550)', () => {
  it('se guarda y queda auditado con quién y desde qué', async () => {
    // Cambiar el orden en que se atiende a los clientes es una decisión del
    // negocio: «¿quién puso esto arriba?» tiene que tener respuesta (#697).
    const id = await conversacion('normal', 60);
    const actor = randomUUID();
    const despues = await withTenant(admin, tenant, (c) =>
      cambiarPrioridad(c, { tenantId: tenant, conversationId: id, prioridad: 'urgente', actor }),
    );
    expect(despues.priority).toBe('urgente');

    const auditoria = await admin.query(
      `SELECT actor, metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'conversation.prioridad_cambiada' AND resource_id = $2`,
      [tenant, id],
    );
    expect(auditoria.rowCount).toBe(1);
    expect(auditoria.rows[0].actor).toBe(actor);
    // El `from` importa: «la subió a urgente» y «la bajó a baja» no son la
    // misma decisión.
    expect(auditoria.rows[0].metadata).toMatchObject({ from: 'normal', to: 'urgente' });
  });

  it('una prioridad inventada se rechaza nombrando las que hay', async () => {
    const id = await conversacion('normal', 60);
    await expect(
      withTenant(admin, tenant, (c) =>
        cambiarPrioridad(c, {
          tenantId: tenant,
          conversationId: id,
          prioridad: 'urgentisima' as never,
          actor: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/baja, normal, alta, urgente/);
  });

  it('una conversación de otro negocio no se puede tocar', async () => {
    const otro = (
      await admin.query("INSERT INTO tenants (name) VALUES ('ajeno-prioridad') RETURNING id")
    ).rows[0].id;
    const id = await conversacion('normal', 60);
    await expect(
      withTenant(admin, otro, (c) =>
        cambiarPrioridad(c, {
          tenantId: otro,
          conversationId: id,
          prioridad: 'urgente',
          actor: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
  });
});
