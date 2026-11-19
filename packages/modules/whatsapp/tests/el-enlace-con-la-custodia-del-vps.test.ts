import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSecretStore, type GoogleSecretStore } from '@iaxti/google';
import { isChannelSecretRef } from '@iaxti/module-channels';
import { resolveChannelWebhookSecret, secretStoreDelCanal } from '../application/webhook-secret';

/**
 * El secreto del canal, con la custodia que de VERDAD se usa (#1253, ADR-0028).
 *
 * Lo que pasaba, medido con un negocio creado desde cero: el flujo de invitación
 * guardaba el enlace bien, y leerlo de vuelta fallaba. El negocio recibía un
 * error que le decía «revisa la conexión», que era falso. La causa: el validador
 * de referencias solo aceptaba la forma de Google Secret Manager
 * (`projects/<p>/secrets/<n>/versions/<v>`), y la custodia de la v1 es el disco
 * cifrado del VPS, que produce `custodia-local/secrets/<n>/versions/<v>`.
 *
 * Ese flujo de invitaciones se fue con Zavu (#1339), pero la mitad que fallaba
 * quedó: `webhook-secret.ts` es hoy la única traducción de la referencia de la
 * cuenta a secreto, y el webhook la usa en CADA entrega. Acá se prueba con el
 * almacén local, que es el del despliegue real — probarla con un Secret Manager
 * de mentira sería medir el backend que producción NO usa, que es justo cómo el
 * defecto original pasó inadvertido.
 *
 * La otra forma que hoy puede tener la referencia: un NOMBRE DE VARIABLE. Es
 * la que deja el alta de Zernio — `conectar-zernio.mjs` imprime
 * `NOMBRE=secreto` para que quien configura la escriba en el entorno.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';

let directorio: string;
const HABIA_DIR = process.env.GOOGLE_SECRET_DIR;
const HABIA_KEY = process.env.GOOGLE_SECRET_KEY;

beforeAll(async () => {
  directorio = await mkdtemp(join(tmpdir(), 'custodia-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  // La custodia se elige por entorno, y otras suites corren sobre el mismo
  // proceso: sin esto, la que sigue leería una custodia prestada.
  if (HABIA_DIR === undefined) delete process.env.GOOGLE_SECRET_DIR;
  else process.env.GOOGLE_SECRET_DIR = HABIA_DIR;
  if (HABIA_KEY === undefined) delete process.env.GOOGLE_SECRET_KEY;
  else process.env.GOOGLE_SECRET_KEY = HABIA_KEY;
});

afterAll(async () => {
  if (directorio) await rm(directorio, { recursive: true, force: true });
});

const CLAVE = Buffer.alloc(32, 7).toString('base64');

describe('la custodia del canal es la del VPS (ADR-0028, #1253)', () => {
  it('con GOOGLE_SECRET_DIR y GOOGLE_SECRET_KEY el almacén guarda y lee de vuelta', async () => {
    vi.stubEnv('GOOGLE_SECRET_DIR', directorio);
    vi.stubEnv('GOOGLE_SECRET_KEY', CLAVE);

    const ref = await secretStoreDelCanal().put('iaxti-canal-prueba', 'secreto-del-webhook');
    // La referencia es la del DISCO, no la de Google Cloud: si dejara de ser
    // así, esta prueba estaría midiendo el otro backend otra vez sin que
    // nadie lo note.
    expect(ref).toMatch(/^custodia-local\/secrets\/iaxti-canal-prueba\/versions\/\d+$/);
    expect(await secretStoreDelCanal().access(ref)).toBe('secreto-del-webhook');
  });

  it('explícita aunque ya la elige el entorno: la prueba mide el disco, no la selección', async () => {
    vi.stubEnv('GOOGLE_SECRET_DIR', directorio);
    vi.stubEnv('GOOGLE_SECRET_KEY', CLAVE);
    const local = createLocalSecretStore({ directorio, clave: CLAVE });

    const ref = await local.put('iaxti-canal-explicito', 'otro-secreto');
    expect(await local.access(ref)).toBe('otro-secreto');
  });

  it('sin custodia configurada dice QUÉ falta: el webhook lo traduce en su 503', () => {
    delete process.env.GOOGLE_SECRET_DIR;
    delete process.env.GOOGLE_SECRET_KEY;
    // Lanza sincrónico, antes de cualquier await: el camino real lo envuelve,
    // acá se mira directo.
    expect(() => secretStoreDelCanal()).toThrow(/GOOGLE_SECRET_DIR/);
  });
});

describe('el secreto del webhook se resuelve por SU referencia (#1175)', () => {
  const CUENTA = 'cuenta-1';
  const cuenta = { tenantId: TENANT, id: CUENTA, webhookSecretRef: null as string | null };

  it('un nombre de variable se lee del entorno: así deja el alta su secreto', async () => {
    vi.stubEnv('ZERNIO_WEBHOOK_SECRET_PRUEBA', 'secreto-de-prueba');
    const secreto = await resolveChannelWebhookSecret({
      ...cuenta,
      webhookSecretRef: 'ZERNIO_WEBHOOK_SECRET_PRUEBA',
    });
    expect(secreto).toBe('secreto-de-prueba');
  });

  /**
   * La referencia `sm:` es la que generaba el servidor para ESTA cuenta: el
   * nombre lleva el tenant y la cuenta, y es lo único que impide que un
   * negocio lea el secreto de otro. La misma forma, apuntando a otra cuenta,
   * no se toca.
   */
  const prefijoDe = (account: string) =>
    `iaxti-zavu-${TENANT.replaceAll('-', '')}-${account.replaceAll('-', '')}-`;
  const refDe = (account: string) =>
    `sm:projects/proy-de-prueba/secrets/${prefijoDe(account)}${'a'.repeat(32)}/versions/1`;

  it('la forma es la válida solo para su cuenta: el validador lo dice primero', () => {
    expect(isChannelSecretRef(refDe(CUENTA), TENANT, CUENTA)).toBe(true);
    expect(isChannelSecretRef(refDe('cuenta-2'), TENANT, CUENTA)).toBe(false);
  });

  it('la referencia de ESTA cuenta se abre con el almacén', async () => {
    const accesos: string[] = [];
    const tienda = {
      access: async (ref: string) => {
        accesos.push(ref);
        return 'secreto-guardado';
      },
    } as unknown as GoogleSecretStore;

    const ref = refDe(CUENTA);
    const secreto = await resolveChannelWebhookSecret({ ...cuenta, webhookSecretRef: ref }, tienda);

    expect(secreto).toBe('secreto-guardado');
    // Al almacén llega la referencia SIN el prefijo `sm:`.
    expect(accesos).toEqual([ref.slice(3)]);
  });

  it('no acepta la referencia de OTRA cuenta, aunque el formato sea válido', async () => {
    const accesos: string[] = [];
    const tienda = {
      access: async (ref: string) => {
        accesos.push(ref);
        return 'secreto-ajeno';
      },
    } as unknown as GoogleSecretStore;

    const secreto = await resolveChannelWebhookSecret(
      { ...cuenta, webhookSecretRef: refDe('cuenta-2') },
      tienda,
    );

    // Sin secreto y SIN tocar el almacén: pedir y descartar sería leer el
    // secreto de otro negocio para botarlo.
    expect(secreto).toBeUndefined();
    expect(accesos).toEqual([]);
  });

  it('sin referencia no hay secreto, y no se inventa uno', async () => {
    expect(await resolveChannelWebhookSecret({ ...cuenta, webhookSecretRef: null })).toBeUndefined();
    expect(
      await resolveChannelWebhookSecret({ ...cuenta, webhookSecretRef: 'una-cosa-cualquiera' }),
    ).toBeUndefined();
  });
});
