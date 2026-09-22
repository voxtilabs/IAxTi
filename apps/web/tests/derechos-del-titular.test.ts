import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los derechos del titular, ejercibles (#447, Ley 21.719).
 *
 * Exportar y suprimir estaban implementados desde el principio —con su
 * auditoría, el borrado de adjuntos en R2 y la lista de lo que se conserva
 * a propósito— y sin ninguna forma de ejercerlos: dos rutas que no llamaba
 * nadie. Una obligación legal construida y no ejercible es peor que una
 * pendiente, porque parece resuelta.
 */
const PANEL = readFileSync(join(__dirname, '..', 'components', 'crm', 'derechos-del-titular.tsx'), 'utf8');
const FICHA = readFileSync(join(__dirname, '..', 'components', 'crm', 'ficha-contacto.tsx'), 'utf8');

describe('ejercer los derechos', () => {
  it('está en la ficha de la persona, no escondido en un menú', () => {
    // Quien recibe la solicitud llega mirando a esa persona.
    expect(FICHA).toContain('DerechosDelTitular');
  });

  it('la exportación se descarga como archivo, no se muestra para copiar', () => {
    // El JSON es para entregárselo a la persona: dejarlo en pantalla
    // obliga a copiarlo a mano y se copia mal.
    expect(PANEL).toContain('createObjectURL');
    expect(PANEL).toMatch(/download\s*=/);
  });

  it('suprimir exige motivo y confirmación aparte', () => {
    // El motivo no es burocracia: es la evidencia de que hubo solicitud, y
    // el servidor lo exige. Un botón directo sería un borrado irreversible
    // a un clic de distancia.
    expect(PANEL).toMatch(/confirmando/);
    expect(PANEL).toMatch(/disabled=\{ocupado !== null \|\| !motivo\.trim\(\)\}/);
    expect(PANEL).toContain('no se puede deshacer');
  });

  it('dice qué se borró Y qué se conservó', () => {
    // Una supresión que no dice qué dejó en pie no es evidencia de nada, y
    // es lo primero que pregunta quien reclama.
    expect(PANEL).toContain('conservado');
    expect(PANEL).toMatch(/mensajesBorrados/);
    expect(PANEL).toMatch(/adjuntosR2/);
  });

  it('no aparece en el panel de la bandeja', () => {
    // Ahí se está atendiendo a alguien, no administrando sus datos.
    expect(FICHA).toMatch(/!compacta && <DerechosDelTitular/);
  });
});
