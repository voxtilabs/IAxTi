/**
 * Las credenciales se guardan POR REFERENCIA: en la base va el NOMBRE de la
 * variable de entorno, nunca el valor (SPEC §17).
 *
 * ## Por qué esto vive en core y no en cada módulo
 *
 * Porque estaba en uno solo. `payments` lo comprobaba —sin espacios, sin `:`
 * ni `=`— con el comentario «Paranoia §17: si alguien pega la credencial en
 * vez del nombre, se corta». `channels`, que guarda la llave del WhatsApp por
 * el que pasa toda la conversación del negocio, hacía `INSERT … $4` con el
 * valor tal cual (#801).
 *
 * El runbook de producción, en cambio, decía que lo hacían los dos: «Los
 * canales y los pagos guardan el nombre de la variable de entorno, nunca el
 * valor. Una credencial con `:` o `=` se rechaza a propósito». Quien le creyó
 * y pegó la llave de verdad quedó con un secreto vivo en texto plano.
 *
 * ## Por qué no basta con `:` y `=`
 *
 * Porque la llave que de verdad usamos no tiene ninguno de los dos. Una de
 * Zavu se ve así: `zv_live_ac73feebf3f29cd43fcd3222624272ecd2a854133b050eea`
 * — sin espacios, sin `:`, sin `=`. La guarda de la que presumía el runbook
 * tampoco la habría rechazado.
 *
 * Lo que sí las separa es la FORMA de un nombre de variable: mayúsculas,
 * dígitos y `_`, empezando por letra, y corto. Todas las referencias del
 * repo la cumplen (`ZAVU_API_KEY`, `R2_BUCKET_ADJUNTOS`, `AUDIT_EXPORT_SECRET`)
 * y los secretos de los proveedores que usamos —`zv_live_…`, `nvapi-…`,
 * `sk-…`, los JWT de Supabase— no, porque van en minúscula.
 *
 * No es una prueba criptográfica: alguien decidido puede pegar un secreto en
 * mayúsculas. Es la diferencia entre un accidente que se caza y uno que no.
 */

/** Mayúsculas, dígitos y `_`, empezando por letra. Como se nombra un env. */
const NOMBRE_DE_VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function esNombreDeVariable(valor: string | null | undefined): boolean {
  return typeof valor === 'string' && NOMBRE_DE_VARIABLE.test(valor);
}

/**
 * Valida y devuelve la referencia, o explica qué va ahí.
 *
 * El mensaje NO repite lo que la persona escribió: si pegó el secreto,
 * repetirlo lo manda al log, al cuerpo del error y a la pantalla.
 */
export function exigirNombreDeVariable(valor: string | null | undefined, campo: string): string {
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new Error(`Falta ${campo}: va el NOMBRE de la variable de entorno que tiene la credencial.`);
  }
  const limpio = valor.trim();
  if (!NOMBRE_DE_VARIABLE.test(limpio)) {
    throw new Error(
      `${campo} es el NOMBRE de la variable de entorno, jamás la credencial. Se escribe en ` +
        'mayúsculas con guiones bajos, como ZAVU_API_KEY.',
    );
  }
  return limpio;
}

/**
 * La referencia, para mostrarla en un mensaje de error.
 *
 * El nombre de una variable no es un secreto y decirlo es media solución para
 * el operador: «falta ZAVU_API_KEY en este ambiente» es accionable. Pero
 * cinco lugares lo interpolaban sin mirar qué había guardado, así que una
 * cuenta vieja con un secreto pegado en ese campo lo re-publicaba en el
 * cuerpo de la respuesta de la API — a cualquier cliente que pegue ahí.
 *
 * Entonces se muestra solo si tiene forma de nombre. Lo que no la tiene no se
 * imprime: se dice que la referencia guardada no sirve, que es la información
 * que el operador necesita de todas formas.
 */
export function refParaMostrar(ref: string | null | undefined): string {
  if (ref === null || ref === undefined || ref === '') return '(sin referencia)';
  return esNombreDeVariable(ref) ? ref : '(la referencia guardada no es un nombre de variable)';
}
