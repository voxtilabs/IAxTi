import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { seed, TENANT_NAME } from '../src/seed';
import { limpiarDemo } from './support/limpiar-demo';

/**
 * El negocio de demostración tiene cosas adentro (#432).
 *
 * El seed dejaba el tenant con dos usuarios y nada más: el producto se veía
 * entero en estado vacío, y así no se puede mostrar ni juzgar. Lo que se
 * cuida acá es que cada pantalla principal tenga algo que mostrar, y que
 * ese algo sea COHERENTE — un tablero que dice tres conversaciones el
 * martes con una bandeja vacía es peor que no tener tablero.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenantId: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await limpiarDemo(admin, TENANT_NAME);
  ({ tenantId } = await seed(admin));
});

afterAll(async () => {
  await admin.end();
});

const cuantos = async (sql: string, params: unknown[] = []): Promise<number> => {
  const r = await admin.query(sql, [tenantId, ...params]);
  return Number(r.rows[0].n);
};

describe('lo que hay para mirar después del seed', () => {
  it('la bandeja tiene conversaciones en los estados que importan', async () => {
    // Una bandeja donde todo está resuelto no enseña nada, y una donde nada
    // lo está tampoco: lo que se mira es cómo se ve el trabajo a medias.
    const estados = await admin.query(
      'SELECT state, count(*)::int AS n FROM conversations WHERE tenant_id = $1 GROUP BY 1',
      [tenantId],
    );
    const porEstado = new Map(estados.rows.map((f) => [f.state as string, f.n as number]));
    expect(porEstado.get('new') ?? 0).toBeGreaterThan(0);
    expect(porEstado.get('open') ?? 0).toBeGreaterThan(0);
    expect(porEstado.get('resolved') ?? 0).toBeGreaterThan(0);
  });

  it('hay conversaciones con ida y vuelta, no solo el primer mensaje', async () => {
    const conHilo = await cuantos(
      `SELECT count(*)::int AS n FROM (
         SELECT conversation_id FROM messages WHERE tenant_id = $1
          GROUP BY conversation_id HAVING count(*) > 2) t`,
    );
    expect(conHilo).toBeGreaterThan(0);
  });

  it('hay una conversación FUERA de la ventana de 24 h', async () => {
    // Es el estado que más cuesta entender del producto y el que hay que
    // poder mostrar: por qué no se puede responder sin plantilla.
    const fuera = await cuantos(
      `SELECT count(*)::int AS n FROM conversations
        WHERE tenant_id = $1 AND last_inbound_at < now() - interval '24 hours'`,
    );
    expect(fuera).toBeGreaterThan(0);
  });

  it('el embudo tiene oportunidades abiertas, ganadas y perdidas', async () => {
    const estados = await admin.query(
      'SELECT status, count(*)::int AS n FROM deals WHERE tenant_id = $1 GROUP BY 1',
      [tenantId],
    );
    const porEstado = new Map(estados.rows.map((f) => [f.status as string, f.n as number]));
    for (const estado of ['open', 'won', 'lost']) {
      expect(porEstado.get(estado) ?? 0, estado).toBeGreaterThan(0);
    }
  });

  it('la agenda tiene horas pasadas y próximas, y una a la que no llegaron', async () => {
    expect(await cuantos(
      `SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1 AND starts_at > now()`,
    )).toBeGreaterThan(0);
    expect(await cuantos(
      `SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1 AND status = 'no_show'`,
    )).toBe(1);
  });

  it('el tablero tiene historia, y los últimos días cuadran con la bandeja', async () => {
    // La coherencia es lo que hace útil una demo: si el tablero dice tres
    // conversaciones el martes, tienen que estar en la bandeja. Más atrás
    // son solo agregados —sin hilo que abrir—, que es lo que también pasa
    // en un negocio real cuando la retención ya purgó los mensajes.
    const dias = await cuantos(
      `SELECT count(DISTINCT day)::int AS n FROM daily_metrics WHERE tenant_id = $1`,
    );
    expect(dias).toBeGreaterThanOrEqual(60);

    const desajuste = await admin.query(
      `SELECT d.day, d.value::int AS metrica,
              (SELECT count(*) FROM conversations c
                WHERE c.tenant_id = d.tenant_id AND c.created_at::date = d.day)::int AS reales
         FROM daily_metrics d
        WHERE d.tenant_id = $1 AND d.metric = 'conversaciones_nuevas'
          AND d.day > now()::date - 7`,
      [tenantId],
    );
    for (const fila of desajuste.rows) {
      expect(fila.metrica, `el ${fila.day} el tablero y la bandeja no coinciden`).toBe(fila.reales);
    }
  });

  it('el asistente existe y tiene objetivo', async () => {
    const r = await admin.query('SELECT objetivo FROM agents WHERE tenant_id = $1', [tenantId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].objetivo).toBeTruthy();
  });

  it('a la demo se le puede hablar: widget, conocimiento y asistente autónomo (#1016)', async () => {
    // Las tres cosas que el 24/10 hubo que armar a mano para lograr la
    // primera conversación real. Sin cualquiera de ellas la demo queda muda:
    // sin widget no hay por dónde escribir, sin conocimiento el asistente
    // escala toda pregunta, y en `assist` no contesta solo.
    const widget = await admin.query(
      'SELECT allowed_domain, welcome_message FROM webchat_widgets WHERE tenant_id = $1',
      [tenantId],
    );
    expect(widget.rowCount).toBe(1);
    expect(widget.rows[0].allowed_domain).toBe('localhost');
    // El saludo sin nombre propio (#1037): es copy del widget y el renombre
    // del agente no lo alcanza — con nombre adentro, renombrar deja a una
    // «Sofía» saludando y un «José» firmando.
    expect(widget.rows[0].welcome_message).not.toMatch(/Sofía|José/);

    const fuente = await admin.query('SELECT kind, status FROM sources WHERE tenant_id = $1', [tenantId]);
    expect(fuente.rowCount).toBe(1);
    // `texto`, no `faq`: faq exige JSON y esto es prosa (#1014).
    expect(fuente.rows[0].kind).toBe('texto');

    const agente = await admin.query(
      'SELECT default_mode, autonomous_hours FROM agents WHERE tenant_id = $1',
      [tenantId],
    );
    expect(agente.rows[0].default_mode).toBe('autonomous');
    expect(agente.rows[0].autonomous_hours?.days).toHaveLength(7);
  });

  it('hay atajos y etiquetas: la bandeja se ve como la de alguien que trabaja', async () => {
    expect(await cuantos('SELECT count(*)::int AS n FROM quick_replies WHERE tenant_id = $1')).toBeGreaterThan(2);
    expect(await cuantos('SELECT count(*)::int AS n FROM tags WHERE tenant_id = $1')).toBeGreaterThan(2);
  });

  it('ningún teléfono es de una persona de verdad', async () => {
    // Si esto alguna vez corre contra una base equivocada, que no le
    // escriba a nadie. El rango 99 no se asigna a personas en Chile.
    const r = await admin.query('SELECT phone FROM contacts WHERE tenant_id = $1', [tenantId]);
    for (const fila of r.rows) {
      expect(String(fila.phone), 'teléfono fuera del rango de prueba').toMatch(/^\+56999000\d{3}$/);
    }
  });

  it('correrlo de nuevo no duplica ni una fila', async () => {
    const antes = await cuantos('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1');
    const conversacionesAntes = await cuantos(
      'SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1',
    );
    const segundo = await seed(admin);
    expect(segundo.demo.yaEstaba).toBe(true);
    // La URL del chat se imprime en TODAS las corridas (#1016), así que el
    // widget tiene que volver también cuando los datos ya estaban.
    expect(segundo.demo.widgetId).toBeTruthy();
    expect(await cuantos('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1')).toBe(antes);
    expect(await cuantos('SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1')).toBe(
      conversacionesAntes,
    );
  });
});
