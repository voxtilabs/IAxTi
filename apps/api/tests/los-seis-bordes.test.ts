import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/readiness';

/**
 * `/ready` informa los SEIS bordes con el mundo, no cuatro (#997).
 *
 * Vigilaba Postgres, Redis, el canal y la IA. Faltaban el correo, los
 * adjuntos, el calendario y los pagos — y los tres primeros son justamente los
 * que se apagan sin que nada lo diga. La evidencia es de esta semana: el SMTP
 * se armaba contra el puerto 0 porque el compose pasaba la variable vacía
 * (#985), los correos no salían, el envío es mejor-esfuerzo, y no había
 * ninguna pantalla donde eso se viera.
 *
 * Lo que estas pruebas cuidan son las tres afirmaciones que hacen que esto
 * sirva: que aparezcan, que NO bloqueen, y que «a medias» se distinga de «sin
 * configurar» — porque mandan a hacer cosas distintas.
 */
const ENV = { ...process.env };
const BORDES = ['correo', 'adjuntos', 'calendario', 'pagos'];
const TODAS: Record<string, string[]> = {
  correo: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
  adjuntos: ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_ADJUNTOS'],
  calendario: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  pagos: ['FLOW_API_KEY', 'FLOW_SECRET_KEY'],
};

beforeEach(() => {
  for (const vs of Object.values(TODAS)) for (const v of vs) delete process.env[v];
});
afterEach(() => {
  process.env = { ...ENV };
});

/** Sin pool: lo que se mira acá es la configuración, no la base. */
const ready = () => checkReadiness(null, 'api');
const de = async (nombre: string) =>
  (await ready()).dependencias.find((d) => d.nombre === nombre);

describe('los seis bordes', () => {
  it('los cuatro nuevos aparecen con su nombre', async () => {
    const nombres = (await ready()).dependencias.map((d) => d.nombre);
    for (const borde of BORDES) expect(nombres, borde).toContain(borde);
  });

  it('sin configurar: lo dice, y dice QUÉ se pierde', async () => {
    const correo = await de('correo');
    expect(correo?.ok).toBe(false);
    expect(correo?.detalle).toContain('Sin configurar');
    // Lo accionable es la consecuencia, no la ausencia.
    expect(correo?.detalle).toContain('invitación');
    expect((await de('adjuntos'))?.detalle).toContain('vence');
    expect((await de('calendario'))?.detalle).toContain('tomada');
  });

  it('NINGUNO de los cuatro degrada el servicio', async () => {
    // Un despliegue sin adjuntos es legítimo —el simulador, una demo— y un
    // ambiente sin SMTP también. Castigarlo sería peor que el problema.
    const r = await ready();
    for (const borde of BORDES) {
      expect(r.dependencias.find((d) => d.nombre === borde)?.bloquea, borde).toBe(false);
    }
    /**
     * Y la afirmación que de verdad importa, dicha sobre la regla y no sobre
     * el resultado: NINGUNO de los cuatro aparece entre los que degradan.
     *
     * Primero puse `expect(r.status).toBe('ok')` y estaba mal: acá no hay
     * pool, así que `postgres` degrada —«Sin DATABASE_URL configurada»— y eso
     * es correcto. Afirmar el estado global habría hecho pasar la prueba por
     * una razón ajena, o fallarla como me falló, por otra.
     */
    const degradan = r.dependencias.filter((d) => !d.ok && d.bloquea !== false).map((d) => d.nombre);
    expect(degradan).toEqual(['postgres']);
  });

  it('a medias NO es lo mismo que sin configurar', async () => {
    // Tres de cuatro: «configurá R2 de cero» manda a rehacer lo que ya está;
    // «te falta una» manda a buscar la que falta.
    process.env.R2_ENDPOINT = 'https://ejemplo.r2.cloudflarestorage.com';
    process.env.R2_ACCESS_KEY_ID = 'una';
    process.env.R2_SECRET_ACCESS_KEY = 'otra';
    const adjuntos = await de('adjuntos');
    expect(adjuntos?.detalle).toContain('a medias');
    expect(adjuntos?.detalle).toContain('1 de 4');
    expect(adjuntos?.ok).toBe(false);
  });

  it('la cadena VACÍA cuenta como ausente, que es el caso que pasó de verdad', async () => {
    // El compose interpola `${SMTP_HOST}` pelado: sin valor en Dokploy, la
    // variable llega como cadena vacía y no como ausente. Es el defecto de
    // #985 y de la regla de #613, y es el que esto tiene que ver.
    for (const v of TODAS.correo) process.env[v] = '';
    expect((await de('correo'))?.detalle).toContain('Sin configurar');
  });

  it('completo: lo dice sin agregar nada', async () => {
    for (const v of TODAS.pagos) process.env[v] = 'puesto';
    const pagos = await de('pagos');
    expect(pagos?.ok).toBe(true);
    expect(pagos?.detalle).toBe('Configurado.');
  });

  it('no publica el nombre de ninguna variable de secreto', async () => {
    // `/ready` no pide sesión. Decir «falta FLOW_SECRET_KEY» es contarle a
    // cualquiera cómo se llama lo que falta; para actuar alcanza con cuántas.
    const r = await ready();
    const texto = JSON.stringify(r);
    for (const v of Object.values(TODAS).flat()) expect(texto, v).not.toContain(v);
  });
});
