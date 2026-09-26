import { BadRequestException, Body, type PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';

/**
 * Validar la entrada con un esquema, no con sesenta `if` a mano (#524).
 *
 * Antes cada ruta escribía su propia comprobación:
 *
 *     if (!body?.filename) {
 *       throw new BadRequestException({
 *         code: 'VALIDATION_ERROR',
 *         message: 'Dinos el nombre del archivo.',
 *         details: [{ field: 'filename' }],
 *       });
 *     }
 *
 * Eran 60 de esos en 22 de los 30 controladores, y el tipo del `@Body()` era
 * una declaración y no una comprobación: `{ key?: string }` no valida nada en
 * ejecución. Lo que llega es lo que el navegador quiso mandar.
 *
 * Dos cosas que este puente cuida, y son las que se pierden al adoptar zod sin
 * pensar:
 *
 * 1. **El formato de error no cambia.** `{ code, message, requestId, details[] }`
 *    es el contrato de la API (SPEC §28) y de él dependen el SDK y las
 *    pantallas. Un `ZodError` crudo llegaría al filtro como error no
 *    controlado y saldría un 500 genérico.
 * 2. **El mensaje sigue siendo para quien atiende.** Los mensajes de zod son
 *    para quien programa («Required», «Expected string, received number»), y
 *    acá los lee alguien que está con un cliente esperando. Por eso el mensaje
 *    va ESCRITO en el esquema y el puente usa el del primer problema.
 */

/** El campo que falló, en la forma que ya usaban los `details`. */
function campoDe(ruta: readonly (string | number | symbol)[]): string | undefined {
  return ruta.length > 0 ? ruta.map(String).join('.') : undefined;
}

/**
 * Valida y devuelve el dato tipado, o lanza el error de siempre.
 *
 * Se exporta suelto además del decorador porque hay entradas que no son el
 * cuerpo —una query compuesta, un cuerpo que ya viene transformado— y
 * obligarlas a pasar por el decorador sería peor que tener las dos puertas.
 */
export function validar<T extends ZodType>(esquema: T, valor: unknown): z.output<T> {
  const r = esquema.safeParse(valor);
  if (r.success) return r.data;
  const problemas = r.error.issues;
  const primero = problemas[0];
  throw new BadRequestException({
    code: 'VALIDATION_ERROR',
    // El mensaje del esquema, que está escrito en la voz del producto. El
    // genérico solo aparece si un esquema olvidó escribirlo, y se nota.
    message: primero?.message ?? 'Revisa los datos e intenta de nuevo.',
    // TODOS los problemas, no solo el primero: un formulario puede pintar
    // varios campos a la vez, y el mensaje de arriba es el que se lee.
    details: problemas.map((p) => {
      const campo = campoDe(p.path);
      return campo ? { field: campo, message: p.message } : { message: p.message };
    }),
  });
}

/**
 * El esquema como PIPE de Nest, que es donde va la validación.
 *
 * Primero lo intenté con `createParamDecorator` y el esquema como `data`: el
 * dato llegaba `undefined` a la fábrica y cada ruta respondía 500 con
 * «Cannot read properties of undefined (reading 'safeParse')». Un pipe recibe
 * el valor directo, es el lugar idiomático, y de paso `@Body()` sigue siendo
 * `@Body()` — así que nada de lo que Nest hace con el cuerpo cambia.
 */
class PipeDeZod<T extends ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly esquema: T) {}
  transform(valor: unknown): z.output<T> {
    return validar(this.esquema, valor ?? {});
  }
}

/**
 * La forma del cuerpo de cada ruta, por `operationId` (#524).
 *
 * Existe por algo que casi rompe el Agente General. El generador del catálogo
 * (#492) saca la forma de los argumentos del AST de los `@Body() body: {...}`
 * inline, porque Nest no la publica en el OpenAPI. Al cambiar la primera ruta a
 * zod, su entrada del catálogo quedó con `"properties": {}` — o sea, el agente
 * llamaría esa herramienta a ciegas. Con 22 controladores convertidos, las 195
 * herramientas se quedaban sin argumentos.
 *
 * Así que el esquema se registra acá cuando se declara, y el generador lo lee
 * de este mapa. Sale MEJOR que antes: JSON Schema de verdad, derivado del mismo
 * esquema que valida, en vez de la forma adivinada desde un tipo inline.
 *
 * La llave es `Controlador_metodo`, el mismo `operationId` que usa Nest.
 */
export const ESQUEMAS_DE_CUERPO = new Map<string, unknown>();

/**
 * Reemplaza a `@Body()` y valida con el esquema.
 *
 * El tipo del parámetro se escribe como `z.infer<typeof Esquema>`: el esquema
 * es la única fuente. Escribirlo a mano además del esquema sería el mismo
 * problema de antes con un paso más.
 *
 * Hay una guarda que falla el PR si aparece un `@Body()` sin esquema: sin eso,
 * el patrón viejo vuelve en la primera ruta nueva.
 */
export function Cuerpo<T extends ZodType>(esquema: T): ParameterDecorator {
  const body = Body(new PipeDeZod(esquema));
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey !== undefined) {
      const operationId = `${(target as object).constructor.name}_${String(propertyKey)}`;
      // `io: 'input'` importa: un esquema con `.transform()` o `.default()`
      // tiene una forma de ENTRADA distinta de la de salida, y lo que el
      // agente tiene que mandar es la de entrada.
      ESQUEMAS_DE_CUERPO.set(operationId, z.toJSONSchema(esquema, { io: 'input' }));
    }
    body(target, propertyKey!, parameterIndex);
  };
}

/**
 * Atajos para lo que se repite, con el mensaje ya escrito.
 *
 * Existen porque «un texto que no venga vacío» aparece en casi todas las rutas,
 * y repetir el `.min(1, '...')` es repetir la oportunidad de olvidar el
 * mensaje.
 *
 * Y el mensaje va en los DOS lugares —el tipo y la restricción— porque no es
 * lo mismo: con el campo ausente falla el TIPO, no el largo, y ahí sale el
 * mensaje por defecto de zod («Invalid input: expected string, received
 * undefined»). Lo cazó la prueba de este archivo, y es el caso más común de
 * todos: el campo que no viene.
 */
export const textoRequerido = (mensaje: string) =>
  z.string({ error: mensaje }).trim().min(1, mensaje);

/** Un id que viene del navegador. No valida que exista: eso lo hace la consulta. */
export const idRequerido = (mensaje: string) => z.string({ error: mensaje }).uuid(mensaje);

/** `AAAA-MM-DD` en la zona del negocio, que es como viajan las fechas acá. */
export const diaRequerido = (mensaje: string) =>
  z.string({ error: mensaje }).regex(/^\d{4}-\d{2}-\d{2}$/, mensaje);
