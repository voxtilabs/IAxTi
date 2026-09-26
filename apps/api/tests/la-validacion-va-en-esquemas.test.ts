import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La validación de entrada va en un esquema, no en un `if` a mano (#524).
 *
 * Eran 56 `VALIDATION_ERROR` escritos uno por uno en 22 de los 30
 * controladores, y el tipo del `@Body()` era una declaración y no una
 * comprobación: `{ key?: string }` no valida nada en ejecución. Quedan 19, y
 * cada uno está acá con su motivo.
 *
 * Los dos motivos legítimos, y no hay un tercero:
 *
 *  - **Relevo**: el `throw` está en un `catch` y repite el mensaje que puso el
 *    módulo (`message: (err as Error).message`). Mover eso a un esquema
 *    duplicaría el texto y dejaría la comprobación del módulo igual, así que
 *    habría dos fuentes para la misma regla.
 *  - **Depende del actor o de los datos**: que una llave empiece con el tenant
 *    de quien pide, que un rango no pase de un año contado desde la zona del
 *    negocio, que el modo live esté prohibido fuera de producción. El esquema
 *    no conoce al actor ni al tenant.
 *
 * Un `VALIDATION_ERROR` nuevo que no esté en esta lista falla el PR. Sin eso el
 * patrón viejo vuelve en la primera ruta nueva — que es exactamente cómo
 * llegaron a ser 56.
 */
const SRC = join(__dirname, '..', 'src');

const CON_MOTIVO: Record<string, number> = {
  // Relevos: el mensaje lo escribe el módulo.
  'campos.controller.ts': 1,
  'campanas.controller.ts': 2,
  'tags.controller.ts': 1,
  'plantillas.controller.ts': 1,
  'deals.controller.ts': 4,
  // Relevo del dominio: el mensaje lo arma comparando `custom` contra los
  // campos que DECLARÓ ese negocio (tipo, obligatoriedad, opciones de lista).
  // El esquema no sabe qué declaró cada tenant.
  'contacts.controller.ts': 1,
  // Mixtos: un relevo y validaciones que necesitan la zona del negocio.
  'agenda.controller.ts': 3,
  // El rango de fechas se valida contra la zona del tenant, que se lee de la
  // base dentro del `withTenant`: el esquema no la tiene.
  'analytics.controller.ts': 2,
  // La llave tiene que empezar con el tenant de QUIEN PIDE.
  'knowledge.controller.ts': 1,
  // «Texto o adjunto, pero algo»: la regla mira dos campos ya filtrados por el
  // prefijo del tenant, que el esquema no conoce.
  'conversations.controller.ts': 1,
  // El modo live prohibido fuera de producción (NODE_ENV) y la firma del
  // webhook del proveedor, que se verifica sobre el cuerpo crudo.
  'payments.controller.ts': 2,
};

function controladores(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith('.controller.ts'));
}

const cuantos = (archivo: string) =>
  (readFileSync(join(SRC, archivo), 'utf8').match(/code: 'VALIDATION_ERROR'/g) ?? []).length;

describe('la validación de entrada va en esquemas (#524)', () => {
  it('el escáner encuentra los controladores', () => {
    expect(controladores().length).toBeGreaterThan(25);
  });

  it('ningún VALIDATION_ERROR a mano sin motivo escrito', () => {
    const sinMotivo = controladores()
      .map((a) => ({ a, n: cuantos(a) }))
      .filter(({ a, n }) => n > (CON_MOTIVO[a] ?? 0))
      .map(({ a, n }) => `${a}: ${n} (permitidos ${CON_MOTIVO[a] ?? 0})`);
    expect(
      sinMotivo,
      'Validación de entrada escrita a mano. Ponla en un esquema zod con ' +
        '`@Cuerpo(Esquema)` (mira knowledge.controller.ts), o si de verdad no puede ' +
        'ir en un esquema, agrégalo a CON_MOTIVO con el por qué:\n  ' + sinMotivo.join('\n  '),
    ).toEqual([]);
  });

  it('la lista no junta polvo: nadie tiene MENOS de los que dice', () => {
    // Si alguien convierte uno más y no baja el número, la lista deja de ser
    // el inventario de lo que falta y pasa a ser un permiso abierto.
    const sobran = controladores()
      .filter((a) => CON_MOTIVO[a] !== undefined && cuantos(a) < CON_MOTIVO[a])
      .map((a) => `${a}: tiene ${cuantos(a)} y la lista dice ${CON_MOTIVO[a]}`);
    expect(sobran, 'Baja el número en CON_MOTIVO:\n  ' + sobran.join('\n  ')).toEqual([]);
  });

  it('los archivos de la lista existen', () => {
    const fantasmas = Object.keys(CON_MOTIVO).filter((a) => !controladores().includes(a));
    expect(fantasmas, 'Sácalos de CON_MOTIVO: ya no están').toEqual([]);
  });

  it('el puente se usa: hay esquemas registrados por operación', async () => {
    // Si `@Cuerpo` dejara de registrar, el catálogo del Agente General volvería
    // a quedarse sin argumentos y nadie se enteraría: las 195 herramientas
    // seguirían ahí, llamándose a ciegas.
    //
    // Hay que cargar los CONTROLADORES y no solo `validar`: el registro pasa
    // cuando el decorador se evalúa, o sea al importar el módulo que lo usa.
    // La primera versión de esta prueba importaba solo `validar` y medía cero —
    // habría pasado por verde el día que el registro se rompiera de verdad.
    await import('../src/app.module');
    const { ESQUEMAS_DE_CUERPO } = await import('../src/validar');
    expect(ESQUEMAS_DE_CUERPO.size).toBeGreaterThan(30);
  });
});
