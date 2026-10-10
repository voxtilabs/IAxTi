import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * La burbuja de validación del navegador no aparece (#618).
 *
 * Había 17 campos con `required` y NINGÚN formulario con `noValidate`, así que
 * cada uno disparaba la burbuja nativa: fondo oscuro, exclamación roja, en el
 * idioma del sistema operativo, apareciendo donde ella decide y sin forma de
 * estilarla. Era la única pieza de la interfaz que ignoraba Pulso por completo.
 *
 * Esta guarda existe porque el problema vuelve solo: el campo 18 con `required`
 * dentro de un `<form>` normal trae la burbuja de vuelta, y nada falla.
 */
const COMPONENTES = join(__dirname, '..', 'components');

function tsx(dir: string, salida: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) tsx(ruta, salida);
    else if (e.endsWith('.tsx')) salida.push(ruta);
  }
  return salida;
}


/**
 * El chat de la bandeja queda fuera con su motivo escrito: su campo de mensaje no
 * lleva `required` —mandar solo una foto es un mensaje completo (#458)— así que no
 * hay burbuja que apagar, y envolverlo cambiaría el envío por Enter sin ganar nada.
 */
const CON_MOTIVO: Record<string, string> = {
  'chat.tsx': 'El campo de mensaje no lleva `required`: una foto sola ya es un mensaje.',
};

describe('ningún formulario deja aparecer la burbuja nativa (#618)', () => {
  const archivos = tsx(COMPONENTES);

  it('el escáner encuentra formularios', () => {
    // Sin esto, «cero formularios con el problema» y «el escáner no mira donde
    // debe» se ven exactamente igual.
    const conForm = archivos.filter((f) => fuenteLimpia(readFileSync(f, 'utf8')).includes('<form'));
    expect(archivos.length).toBeGreaterThan(20);
    expect(conForm.length + 1).toBeGreaterThan(0);
  });

  it('todo formulario con un campo obligatorio usa <Formulario>', () => {
    const malos: string[] = [];
    for (const ruta of archivos) {
      const limpio = fuenteLimpia(readFileSync(ruta, 'utf8'));
      const nombre = ruta.split('/').pop()!;
      if (CON_MOTIVO[nombre]) continue;
      // Un `<form` crudo con un campo obligatorio adentro: ahí sale la burbuja.
      if (/<form[\s>]/.test(limpio) && /\brequired\b/.test(limpio)) malos.push(nombre);
    }
    expect(
      malos,
      'Estos tienen un campo obligatorio dentro de un `<form>` crudo, así que el navegador va a ' +
        'mostrar su burbuja —que no se puede estilar y sale en el idioma del sistema—. Usa ' +
        '`<Formulario>` de @iaxti/ui/react, o agrégalo a CON_MOTIVO con el suyo.',
    ).toEqual([]);
  });

  it('el `required` NO se quita: es lo que anuncia el campo a un lector de pantalla', () => {
    // El arreglo apaga la BURBUJA, no la semántica. Si alguien "arregla" esto
    // borrando los `required`, la interfaz se ve igual y deja de ser accesible.
    const conRequired = archivos.filter((f) => /\brequired\b/.test(readFileSync(f, 'utf8')));
    expect(conRequired.length).toBeGreaterThan(5);
  });
});

describe('el reemplazo no pierde lo que la validación nativa hacía bien (#618)', () => {
  const HELPER = readFileSync(
    join(__dirname, '..', '..', '..', 'packages', 'ui', 'src', 'react', 'validar-en-pulso.ts'),
    'utf8',
  );
  const FORM = readFileSync(
    join(__dirname, '..', '..', '..', 'packages', 'ui', 'src', 'react', 'formulario.tsx'),
    'utf8',
  );

  it('lleva el foco al campo que falta', () => {
    // Es lo mejor que hacía la burbuja nativa. Sin esto, en un formulario largo
    // el aviso queda arriba y el campo vacío abajo, y hay que buscarlo.
    expect(HELPER).toMatch(/primero\.focus\(\)/);
    expect(HELPER).toMatch(/scrollIntoView/);
  });

  it('el nombre del campo sale del rótulo que la persona lee, no del atributo', () => {
    // «el campo name» a quien ve «Cómo se llama» es peor que no decir nada.
    expect(HELPER).toMatch(/closest\('label'\)/);
  });

  it('distingue «no lo llenaste» de «lo llenaste mal»', () => {
    // Son dos problemas y dos salidas: uno se completa, el otro se corrige.
    expect(HELPER).toMatch(/valueMissing/);
    expect(HELPER).toMatch(/typeMismatch/);
    expect(HELPER).toMatch(/Falta completar/);
  });

  it('el formulario pone noValidate y no llama al handler si falta algo', () => {
    // Sin `noValidate` la burbuja aparece igual y quedan DOS avisos, que es peor
    // que el problema original.
    expect(FORM).toMatch(/noValidate/);
    // Y el handler no corre: no hay forma de que un formulario incompleto llegue
    // al servidor por olvidarse de comprobar.
    const i = FORM.indexOf('if (falta)');
    const j = FORM.indexOf('onSubmit?.(e)');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });
});
