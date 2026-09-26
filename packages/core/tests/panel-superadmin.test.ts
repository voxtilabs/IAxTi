import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Las tres funciones del panel que no tenían pantalla (#447).
 *
 * `GET /platform/tenants/por-borrar`, `GET /platform/ia/prompts` y
 * `PUT /platform/tenants/:id/api-quota` existían con permisos, auditoría y
 * tests de API — y ningún frontend las llamaba. La cola de borrado es la
 * que más pesa: la decisión era «el sistema avisa y una PERSONA borra», y
 * el aviso no llegaba a ningún escritorio.
 *
 * El guard de rutas (`rutas-frontend`) comprueba lo contrario —que el
 * frontend no pida rutas inexistentes— y por eso este agujero pasaba: una
 * ruta sin consumidor no rompe nada.
 */
const PANEL = readFileSync(
  join(__dirname, '..', '..', '..', 'apps', 'admin', 'components', 'admin-shell.tsx'),
  'utf8',
);

describe('el panel de SuperAdmin usa lo que la API ofrece', () => {
  it('muestra la cola de borrado', () => {
    expect(PANEL).toContain('/platform/tenants/por-borrar');
  });

  it('pero NO ofrece borrar desde esa lista', () => {
    // Borrar es irreversible y se lleva los datos de los clientes de
    // nuestro cliente: no puede ser la acción más cercana a la lista.
    const bloque = PANEL.slice(PANEL.indexOf('function ColaDeBorrado'), PANEL.indexOf('interface PromptActivoDto'));
    expect(bloque).not.toMatch(/action: 'delete'|\/state[\s\S]{0,80}delete/);
  });

  it('muestra qué prompt corre en cada negocio', () => {
    expect(PANEL).toContain('/platform/ia/prompts');
    // Los que no tienen versión fijada se mueven solos cuando cambia el
    // prompt por defecto: es lo que hay que poder ver de un vistazo.
    expect(PANEL).toContain('sin fijar');
  });

  it('deja cambiar el tope de API de un tenant, y volver al del plan', () => {
    expect(PANEL).toContain('api-quota');
    // Vacío = el del plan. Un override que solo se puede poner obliga a
    // recordar de memoria el número que tenía el plan.
    expect(PANEL).toMatch(/valor\.trim\(\) === '' \? null : Number\(valor\)/);
  });

  it('deja crear un negocio y cortar el soporte antes de que venza (#480)', () => {
    // `POST /platform/tenants` y `DELETE /platform/tenants/:id/support`
    // existían desde #69 y #219 sin que nadie las llamara: un cliente que
    // se cierra por teléfono había que meterlo por la API, y el soporte se
    // encendía por cuatro horas sin forma de apagarlo antes —con el
    // cliente viendo el aviso de que lo estamos mirando.
    expect(PANEL).toContain("accion('/platform/tenants', {");
    expect(PANEL).toContain("{ method: 'DELETE' }");
    // Nace en prueba, y el botón lo dice: crear un negocio ya cobrando
    // sería una decisión tomada por accidente.
    expect(PANEL).toContain('nace en prueba');
  });

  it('el Agente General se puede APAGAR desde el panel (#496)', () => {
    // Es la pieza más crítica: configura negocios ajenos conversando. Poder
    // verlo no alcanza — hay que poder apagarlo sin desplegar, y a las 2 de
    // la mañana nadie va a buscar un flag en un YAML.
    expect(PANEL).toContain('/platform/agente-general/');
    expect(PANEL).toContain('Apagar para todos');
    // Y por negocio, sin tener que apagarlo para todos.
    expect(PANEL).toContain('Apagar en este negocio');
  });

  it('el motivo del apagado es obligatorio en la pantalla', () => {
    // Un interruptor sin motivo, a los tres días, nadie sabe si se puede
    // volver a encender: termina en un producto apagado "por si acaso".
    expect(PANEL).toContain('!motivo.trim()');
  });

  it('muestra qué hizo, cuánto costó y qué falló', () => {
    for (const columna of ['Qué le pidieron', 'Herramientas', 'Latencia p95', 'Fallidas']) {
      expect(PANEL, columna).toContain(columna);
    }
  });

  it('el Agente General va ANTES del centro de IA', () => {
    // Su interruptor es lo primero que alguien busca cuando algo va mal.
    expect(PANEL.indexOf('<AgenteGeneralPanel />')).toBeLessThan(PANEL.indexOf('<CentroIA />'));
  });

  it('deja fijar la retención de un negocio, y muestra qué se llevaría (#460)', () => {
    // La retención sale del plan; el override por tenant —lo que se le
    // promete a un cliente que pide guardar más, o menos— había que
    // escribirlo en `tenants.settings` a mano.
    expect(PANEL).toContain('/retention');
    // Lo que decide no es el número de meses: es cuántas conversaciones se
    // llevaría la próxima purga con ese número puesto.
    expect(PANEL).toContain('wouldPurge');
  });
});
