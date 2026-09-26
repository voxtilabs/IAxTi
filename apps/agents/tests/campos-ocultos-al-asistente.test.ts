import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createContact, createCustomField, updateContact } from '@iaxti/module-crm';
import { datosDelNegocioParaLaIa } from '../src/copilot';

/**
 * El interruptor «Oculto al asistente», de verdad (#528).
 *
 * `visible_ia` estaba en la migración, el interruptor en la pantalla de Campos y
 * la insignia «Oculto al asistente» en la lista. La única función que respeta la
 * bandera, `paraLaIa`, no tenía un solo llamador de producción: exportada en el
 * contrato, con su test, y sin usar.
 *
 * Fallaba en los DOS sentidos, y los dos se prueban acá:
 *
 *  - El «sí» no servía: un campo visible nunca llegaba al asistente, así que le
 *    volvía a preguntar al cliente lo que la ficha ya tenía.
 *  - El «no» se cumplía por ACCIDENTE, porque no se mandaba ningún campo. El día
 *    que alguien enchufara `custom` sin acordarse de `paraLaIa`, salían las notas
 *    internas — y los campos que una pyme marca ocultos son justo esos.
 *
 * Se prueba la función que arma el dato, no la respuesta del modelo: lo que
 * importa es QUÉ INFORMACIÓN SALE del negocio, y eso se decide acá.
 */
let pool: Pool;
let tenantId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenantId = (
    await pool.query("INSERT INTO tenants (name) VALUES ('campos-ocultos') RETURNING id")
  ).rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['outbox', 'activities', 'custom_fields', 'contacts']) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenantId]).catch(() => {});
  }
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => {});
  await pool.end();
});

describe('los campos propios y el asistente (#528)', () => {
  it('el visible LLEGA y el oculto NO, en la misma ficha', async () => {
    const contacto = await withTenant(pool, tenantId, async (c) => {
      await createCustomField(c, {
        tenantId,
        entity: 'contact',
        label: 'Modelo del auto',
        type: 'texto',
        visibleIa: true,
      });
      await createCustomField(c, {
        tenantId,
        entity: 'contact',
        label: 'Nota interna',
        type: 'texto',
        visibleIa: false,
      });
      const nuevo = await createContact(c, {
        tenantId,
        name: 'Marcela Soto',
        phone: '+56944443333',
        actor: 'test',
      });
      await updateContact(c, {
        tenantId,
        contactId: nuevo.id,
        custom: { modelo_del_auto: 'Yaris 2019', nota_interna: 'moroso, no dar crédito' },
        actor: 'test',
      });
      return nuevo.id;
    });

    const datos = await withTenant(pool, tenantId, (c) =>
      datosDelNegocioParaLaIa(c, tenantId, contacto),
    );
    const texto = JSON.stringify(datos);

    // El «sí»: es la mitad que estaba rota y la que el negocio nota, porque el
    // asistente le vuelve a preguntar al cliente lo que la ficha ya tiene.
    expect(texto, 'el campo visible tiene que llegar').toContain('Yaris 2019');
    expect(datos).toHaveProperty('Modelo del auto');
    // El «no»: lo que de verdad importa que no salga del negocio.
    expect(texto, 'el campo oculto NO puede salir').not.toContain('moroso');
    expect(datos).not.toHaveProperty('Nota interna');
  });

  it('sin campos declarados devuelve vacío, no una llave con nada adentro', async () => {
    // Quien la usa no agrega la llave cuando está vacía: una llave vacía es una
    // línea más que el modelo lee y que el negocio paga sin que diga nada.
    const otro = (
      await pool.query("INSERT INTO tenants (name) VALUES ('sin-campos-ia') RETURNING id")
    ).rows[0].id;
    try {
      const contacto = await withTenant(pool, otro, (c) =>
        createContact(c, { tenantId: otro, name: 'Sin campos', phone: '+56911112222', actor: 'test' }),
      );
      const datos = await withTenant(pool, otro, (c) =>
        datosDelNegocioParaLaIa(c, otro, contacto.id),
      );
      expect(datos).toEqual({});
    } finally {
      for (const tabla of ['outbox', 'contacts']) {
        await pool.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [otro]).catch(() => {});
      }
      await pool.query('DELETE FROM tenants WHERE id = $1', [otro]).catch(() => {});
    }
  });

  it('un contacto que no existe no revienta el contexto: devuelve vacío', async () => {
    // El contexto del asistente no puede caerse porque un id llegue raro: la
    // conversación sigue y quien atiende no ve un error que no puede arreglar.
    const datos = await withTenant(pool, tenantId, (c) =>
      datosDelNegocioParaLaIa(c, tenantId, '00000000-0000-0000-0000-000000000000'),
    );
    expect(datos).toEqual({});
  });

  it('el copiloto usa la función y no arma el filtro por su cuenta', async () => {
    // Si alguien vuelve a poner `custom` en el contexto sin pasar por acá, el
    // «oculto» se rompe en silencio. Esta es la única cosa que lo sostiene.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fuente = readFileSync(join(__dirname, '..', 'src', 'copilot.ts'), 'utf8');
    expect(fuente).toContain('datosDelNegocioParaLaIa(client, data.tenantId, contactId)');
    // Y nadie mete `custom` crudo en el contexto.
    const contexto = fuente.slice(fuente.indexOf('historialDelContacto'));
    expect(contexto.slice(0, 2000)).not.toMatch(/custom\b(?!Role)/);
  });
});
