'use client';

/**
 * La validación del formulario, en voz de Pulso (#618).
 *
 * Había 17 campos con `required` y **ningún** formulario con `noValidate`, así
 * que cada uno disparaba la burbuja nativa del navegador: fondo oscuro, signo de
 * exclamación rojo, en el idioma del sistema operativo, apareciendo donde ella
 * decide y **sin forma de estilarla**. Era la única pieza de la interfaz que
 * ignoraba Pulso por completo — y la que Lino vio y llamó «un icono de error BIEN
 * FEO», con razón.
 *
 * Lo que este helper NO hace, y es la parte que importa:
 *
 * - **No quita el `required`.** El atributo se queda: es lo que hace que un
 *   lector de pantalla anuncie el campo como obligatorio. Lo que se apaga es la
 *   BURBUJA (`noValidate` en el form), no la semántica.
 * - **No pierde el foco.** La validación nativa lleva el cursor al campo que
 *   falta, y eso es lo mejor que hace. Si lo perdiéramos al reemplazarla,
 *   habríamos cambiado algo feo por algo peor: en un formulario largo, un aviso
 *   arriba y el campo vacío abajo obliga a buscarlo.
 * - **No inventa el nombre del campo.** Lo saca del `<label>` que lo envuelve,
 *   que es el texto que la persona está leyendo. Decirle «el campo name» a quien
 *   ve «Cómo se llama» es peor que no decir nada.
 */

/** El rótulo que la persona ve, sacado del `<label>` que envuelve al campo. */
function rotuloDe(campo: HTMLElement): string | null {
  const etiqueta = campo.closest('label');
  if (!etiqueta) {
    // Sin label envolvente, se prueba con el `aria-label`, que es el otro lugar
    // donde este repo pone el nombre de un control (los botones de icono).
    const aria = campo.getAttribute('aria-label');
    return aria?.trim() || null;
  }
  // El texto del label incluye lo que haya escrito dentro de los controles
  // hijos. Se clona, se les saca el valor, y queda el rótulo.
  const copia = etiqueta.cloneNode(true) as HTMLElement;
  copia.querySelectorAll('input, textarea, select, button').forEach((n) => n.remove());
  const texto = (copia.textContent ?? '').replace(/\s+/g, ' ').trim();
  return texto || null;
}

/**
 * Qué pasó y qué hacer, en una frase. Español de Chile, tuteo.
 *
 * Se distingue «no lo llenaste» de «lo llenaste mal» porque son dos problemas
 * distintos y la salida es distinta: uno se completa, el otro se corrige.
 */
function mensajeDe(campo: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const rotulo = rotuloDe(campo);
  const suyo = rotulo ? `«${rotulo}»` : 'un campo';
  const v = campo.validity;

  if (v.valueMissing) return `Falta completar ${suyo}.`;
  if (v.typeMismatch && (campo as HTMLInputElement).type === 'email') {
    return `Ese correo no se entiende. Revisa que tenga @ y el dominio.`;
  }
  if (v.typeMismatch && (campo as HTMLInputElement).type === 'url') {
    return `Esa dirección no se entiende. Tiene que empezar con https://`;
  }
  if (v.tooShort) {
    const min = (campo as HTMLInputElement).minLength;
    return `${suyo} necesita al menos ${min} caracteres.`;
  }
  if (v.tooLong) {
    const max = (campo as HTMLInputElement).maxLength;
    return `${suyo} no puede pasar de ${max} caracteres.`;
  }
  if (v.rangeUnderflow) return `${suyo} tiene que ser mayor que ${(campo as HTMLInputElement).min}.`;
  if (v.rangeOverflow) return `${suyo} no puede pasar de ${(campo as HTMLInputElement).max}.`;
  if (v.stepMismatch) return `${suyo} tiene que ser un número entero.`;
  // `patternMismatch` y el resto: el patrón no se explica solo, y adivinar qué
  // formato espera sería inventarle una regla al campo.
  return `Revisa ${suyo}: ese valor no sirve.`;
}

/**
 * Revisa el formulario y devuelve el aviso, o `null` si está todo bien.
 *
 * Se usa así, y el `noValidate` del form es imprescindible — sin él la burbuja
 * nativa aparece igual y quedan los dos avisos:
 *
 * ```tsx
 * <form noValidate onSubmit={(e) => {
 *   e.preventDefault();
 *   const falta = validarEnPulso(e.currentTarget);
 *   if (falta) return setError(falta);
 *   …
 * }}>
 * ```
 */
export function validarEnPulso(form: HTMLFormElement): string | null {
  // `checkValidity()` y no `:invalid` a secas: el pseudo-selector también caza
  // campos deshabilitados o fuera del formulario en algunos navegadores.
  if (form.checkValidity()) return null;
  const campos = Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    ),
  );
  const primero = campos.find((c) => !c.disabled && !c.validity.valid);
  if (!primero) return null;
  // El foco va al campo, como hacía la validación nativa. Es lo mejor que hacía
  // y perderlo sería cambiar algo feo por algo peor.
  primero.focus();
  if (typeof primero.scrollIntoView === 'function') {
    primero.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
  return mensajeDe(primero);
}
