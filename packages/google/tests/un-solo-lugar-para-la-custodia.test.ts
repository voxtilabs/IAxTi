import { describe, expect, it } from 'vitest';
import { CustodiaIncompleta, custodiaDesdeEntorno } from '../src/secretos-en-el-vps';

/**
 * Dónde se guarda un secreto se decide en UN lugar (#1175).
 *
 * Había dos y no coincidían: el calendario elegía disco cifrado cuando el
 * entorno lo pedía —que es lo que manda ADR-0028 para la v1— y whatsapp
 * llamaba derecho a `createGoogleSecretStore`. El resultado es que conectar
 * un WhatsApp exigía un proyecto de Google Cloud, y como la custodia se
 * construye ANTES de la primera llamada, el botón devolvía 503 sin llegar a
 * hablar con Zavu. Desde afuera parecía un problema del proveedor.
 *
 * La guarda de fuente que impide una tercera copia vive en `packages/core`
 * (`la-custodia-en-un-solo-lugar.test.ts`): escanear el repo necesita
 * `fuenteLimpia`, y `@iaxti/google` no depende de core — agregarle esa
 * dependencia por una prueba sería invertir quién conoce a quién.
 *
 * El modo de fallar importa tanto como el acierto: una configuración a
 * MEDIAS lanza en vez de caer al otro almacén en silencio. Caer sería
 * guardar los secretos en un lugar que nadie pidió.
 */
describe('el selector', () => {
  const enLaNube = () => ({ nube: true }) as never;

  it('con directorio y llave, guarda en el disco del VPS', () => {
    const s = custodiaDesdeEntorno(enLaNube, {
      GOOGLE_SECRET_DIR: '/tmp/custodia-de-prueba',
      GOOGLE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    } as NodeJS.ProcessEnv);
    expect(s).not.toBeNull();
    expect((s as unknown as { nube?: boolean }).nube).toBeUndefined();
  });

  it('el disco GANA aunque también esté la nube: ADR-0028 dice que la v1 es el disco', () => {
    const s = custodiaDesdeEntorno(enLaNube, {
      GOOGLE_SECRET_DIR: '/tmp/custodia-de-prueba',
      GOOGLE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
      GOOGLE_SECRET_PROJECT_ID: 'un-proyecto',
      GOOGLE_SECRET_LOCATION: 'southamerica-west1',
    } as NodeJS.ProcessEnv);
    expect((s as unknown as { nube?: boolean }).nube).toBeUndefined();
  });

  it('sin nada, devuelve null: no hay custodia, y eso no es un error todavía', () => {
    expect(custodiaDesdeEntorno(enLaNube, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it.each([
    ['GOOGLE_SECRET_DIR', { GOOGLE_SECRET_KEY: 'x' }],
    ['GOOGLE_SECRET_KEY', { GOOGLE_SECRET_DIR: '/tmp/x' }],
    ['GOOGLE_SECRET_PROJECT_ID', { GOOGLE_SECRET_LOCATION: 'southamerica-west1' }],
    ['GOOGLE_SECRET_LOCATION', { GOOGLE_SECRET_PROJECT_ID: 'un-proyecto' }],
  ])('a medias LANZA diciendo que falta %s, en vez de caer al otro almacén', (falta, env) => {
    // Caer al otro sería guardar en un lugar que nadie pidió, y eso no se
    // descubre hasta que hace falta leer el secreto.
    expect(() => custodiaDesdeEntorno(enLaNube, env as NodeJS.ProcessEnv))
      .toThrow(CustodiaIncompleta);
    try {
      custodiaDesdeEntorno(enLaNube, env as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as CustodiaIncompleta).falta).toBe(falta);
    }
  });
});
