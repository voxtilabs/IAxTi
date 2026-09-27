'use client';

import { type FormHTMLAttributes, forwardRef } from 'react';
import { toast } from './ui/avisos';
import { validarEnPulso } from './validar-en-pulso';

/**
 * Un `<form>` que valida en voz de Pulso (#618).
 *
 * Existe para que convertir un formulario sea cambiar UNA palabra —`form` por
 * `Formulario`— y no editar diez manejadores distintos. Cada handler valida lo
 * suyo de forma distinta, y pedirle a cada uno que además llame al validador era
 * garantizar que el próximo formulario se olvide.
 *
 * Hace tres cosas y ninguna es opcional:
 *
 *  1. Pone `noValidate`, que es lo único que apaga la burbuja nativa del
 *     navegador — fondo oscuro, exclamación roja, en el idioma del sistema y sin
 *     forma de estilarla.
 *  2. Si falta algo, muestra el aviso en voz de Pulso y **lleva el foco al
 *     campo**. Eso último es lo mejor que hacía la validación nativa, y perderlo
 *     sería cambiar algo feo por algo peor.
 *  3. Y solo entonces llama a tu `onSubmit`. Si no valida, tu handler no corre:
 *     no hay forma de que un formulario incompleto llegue al servidor por
 *     olvidarse de comprobar.
 *
 * El `required` de los campos **se queda**: es lo que hace que un lector de
 * pantalla los anuncie como obligatorios. Lo que se apaga es la burbuja, no la
 * semántica.
 */
export const Formulario = forwardRef<HTMLFormElement, FormHTMLAttributes<HTMLFormElement>>(
  function Formulario({ onSubmit, ...resto }, ref) {
    return (
      <form
        {...resto}
        ref={ref}
        // Sin esto la burbuja nativa aparece igual y quedan DOS avisos, que es
        // peor que el problema original.
        noValidate
        onSubmit={(e) => {
          const falta = validarEnPulso(e.currentTarget);
          if (falta) {
            e.preventDefault();
            // `toast.error` y NO `AvisoResultado(...)` (#650).
            //
            // `AvisoResultado` es un COMPONENTE: todo lo que hace vive en un
            // `useEffect`. Llamarlo como función desde un manejador de eventos
            // no lo renderiza —React no registra el hook, el efecto nunca corre,
            // el aviso nunca sale— y además LANZA: «Invalid hook call» (React
            // #321), medido con Playwright en las diez pantallas que #618
            // convirtió.
            //
            // Lo que se veía: apretabas el botón, el cursor saltaba a un campo,
            // ningún mensaje, y una excepción en la consola. O sea que #618
            // cambió una burbuja fea por ningún aviso y un error.
            //
            // El aviso imperativo es la forma correcta acá: esto ocurre en
            // respuesta a un evento, no durante un render.
            toast.error(falta);
            return;
          }
          onSubmit?.(e);
        }}
      />
    );
  },
);
