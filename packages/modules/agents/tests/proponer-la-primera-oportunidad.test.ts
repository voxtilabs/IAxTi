import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import {
  ACCIONES_EN_LA_CONVERSACION,
  ARGUMENTOS_DE_LA_ACCION,
  accionQueSePuedeProponer,
} from '../application/acciones-en-la-conversacion';

/**
 * El agente puede proponer CREAR la oportunidad, no solo moverla (#1229).
 *
 * Medido en el tenant del Tech AI Summit después de cinco conversaciones
 * reales con el agente autónomo: 5 contactos, 5 conversaciones, CERO
 * oportunidades. El contacto entra solo con cada mensaje; la oportunidad no la
 * creaba nadie, porque la lista de acciones proponibles tenía `deals.move` y
 * no `deals.create`. O sea que el agente podía mover una oportunidad que no
 * existía y no podía proponer la primera — para un stand, donde todos los que
 * escriben son nuevos, eso es el CRM vacío por definición.
 */
describe('proponer la primera oportunidad (#1229)', () => {
  it('crear una oportunidad está entre lo proponible', () => {
    expect(Object.keys(ACCIONES_EN_LA_CONVERSACION)).toContain('deals.create');
    expect(accionQueSePuedeProponer({ herramienta: 'deals.create', argumentos: { title: 'Corte' } })).not.toBeNull();
  });

  /**
   * `deals.create` es `libre` —está en `SIN_CONFIRMACION` porque «queda
   * adentro del negocio y se deshace»— y ESO era lo que la dejaba afuera:
   * `accionQueSePuedeProponer` exigía `trato === 'confirmar'`.
   *
   * Mirado de cerca estaba al revés. El `trato` decide si el agente puede
   * ejecutarla sola CUANDO lleva herramientas; la propuesta existe para la
   * corrida donde no las lleva. Excluir a las libres significaba «en autónomo
   * una acción libre no puede ocurrir nunca», que es el CRM vacío de #1229.
   */
  it('una herramienta libre también se puede proponer, y la puerta es la lista', async () => {
    const { CATALOGO } = await import('../application/catalogo');
    const h = CATALOGO.find((x) => x.nombre === 'deals.create');
    expect(h, 'deals.create tiene que existir en el catálogo').toBeDefined();
    expect(h!.trato, 'sigue siendo libre: no se cambió el trato de la herramienta').toBe('libre');
    expect(h!.permiso).toBe('crm.deals.create');
    // Y lo que NO está en la lista curada sigue afuera, pase lo que pase con
    // su trato: la puerta es la lista, no el trato.
    expect(accionQueSePuedeProponer({ herramienta: 'tags.create', argumentos: {} })).toBeNull();
    expect(accionQueSePuedeProponer({ herramienta: 'contacts.list', argumentos: {} })).toBeNull();
  });

  /**
   * Al modelo NO se le pide el contacto, aunque la ruta lo exija: lo pone el
   * sistema al aplicar. Un modelo que adivina bien el contacto no es garantía;
   * uno que adivina mal le crea la oportunidad a otra persona, y el dueño la
   * ve en su embudo con el nombre de otro cliente.
   */
  it('los argumentos que se le piden NO incluyen el contacto', () => {
    const args = ARGUMENTOS_DE_LA_ACCION['deals.create'];
    expect(args).toBeDefined();
    expect(args).toContain('title');
    expect(args, 'el contacto lo pone el sistema, no el modelo').not.toContain('contactId');
  });

  /**
   * Y el monto solo si el cliente lo dijo. Sin esta instrucción el modelo
   * rellena un número razonable, y un embudo con montos inventados es peor
   * que un embudo sin montos: el dueño toma decisiones con eso.
   */
  it('el monto va solo si el cliente lo dijo', () => {
    expect(ARGUMENTOS_DE_LA_ACCION['deals.create']).toMatch(/SOLO si el cliente lo dijo/);
  });

  it('el sistema pisa el contacto al aplicar', () => {
    // `__dirname` y no `import.meta.url`: el typecheck del paquete compila con
    // un `module` que no lo admite (TS1343), y una prueba que no typechequea
    // rompe el CI del repo entero por un detalle que no tiene nada que ver con
    // lo que mide.
    const fuente = fuenteLimpia(
      readFileSync(join(__dirname, '..', 'application', 'acciones-que-se-proponen.ts'), 'utf8'),
    );
    const bloque = fuente.slice(fuente.indexOf("'deals.create': {"), fuente.indexOf("'agenda.agendar': {"));
    expect(bloque).toContain('contactId: r.rows[0].contact_id');
  });
});
