import type { PoolClient } from 'pg';

/**
 * Campos personalizados (SPEC §10 y §23, issue 248).
 *
 * La tabla estaba desde el primer día con los seis tipos y sus banderas, y
 * el catálogo de permisos anotaba `crm.fields.manage` como «no construido».
 * Mientras tanto, lo que cada rubro necesita —la talla, la patente, el
 * número de ficha— terminaba en `contacts.custom`, un saco libre donde nadie
 * declara nada. Eso ya mordió: la supresión del titular tuvo que vaciar ese
 * saco entero (#235) justamente porque no se sabe qué hay adentro.
 *
 * Declarar el campo cambia eso: se sabe qué guarda el negocio, de qué tipo
 * es, si es obligatorio y si el copiloto puede verlo.
 */
export const TIPOS_DE_CAMPO = ['texto', 'numero', 'fecha', 'lista', 'si_no', 'moneda'] as const;
export type TipoDeCampo = (typeof TIPOS_DE_CAMPO)[number];

export const ENTIDADES_CON_CAMPOS = ['contact', 'company', 'deal'] as const;
export type EntidadConCampos = (typeof ENTIDADES_CON_CAMPOS)[number];

export interface CampoPersonalizado {
  id: string;
  entity: EntidadConCampos;
  key: string;
  label: string;
  type: TipoDeCampo;
  required: boolean;
  visibleIa: boolean;
  options: string[];
}

function aCampo(row: Record<string, unknown>): CampoPersonalizado {
  return {
    id: row.id as string,
    entity: row.entity as EntidadConCampos,
    key: row.key as string,
    label: row.label as string,
    type: row.type as TipoDeCampo,
    required: Boolean(row.required),
    visibleIa: Boolean(row.visible_ia),
    options: (row.options as string[]) ?? [],
  };
}

/**
 * La llave es con la que el campo viaja en `custom` y en las herramientas
 * del copiloto: se normaliza para que no dependa de cómo lo escribió quien
 * lo creó.
 */
export function llaveDeCampo(texto: string): string {
  const limpia = (texto ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!limpia) throw new Error('El campo necesita un nombre.');
  if (limpia.length > 40) throw new Error('El nombre del campo es muy largo (máximo 40).');
  return limpia;
}

export async function listCustomFields(
  client: PoolClient,
  tenantId: string,
  entity?: EntidadConCampos,
): Promise<CampoPersonalizado[]> {
  const r = await client.query(
    entity
      ? 'SELECT * FROM custom_fields WHERE tenant_id = $1 AND entity = $2 ORDER BY label'
      : 'SELECT * FROM custom_fields WHERE tenant_id = $1 ORDER BY entity, label',
    entity ? [tenantId, entity] : [tenantId],
  );
  return r.rows.map(aCampo);
}

export async function createCustomField(
  client: PoolClient,
  input: {
    tenantId: string;
    entity: string;
    label: string;
    type: string;
    required?: boolean;
    visibleIa?: boolean;
    options?: string[];
  },
): Promise<CampoPersonalizado> {
  if (!(ENTIDADES_CON_CAMPOS as readonly string[]).includes(input.entity)) {
    throw new Error(`No hay campos personalizados para "${input.entity}".`);
  }
  if (!(TIPOS_DE_CAMPO as readonly string[]).includes(input.type)) {
    throw new Error(`Tipo de campo desconocido: ${input.type}.`);
  }
  const key = llaveDeCampo(input.label);
  const options = (input.options ?? []).map((o) => String(o).trim()).filter(Boolean);
  if (input.type === 'lista' && options.length === 0) {
    throw new Error('Un campo de lista necesita sus opciones.');
  }
  const r = await client.query(
    `INSERT INTO custom_fields (tenant_id, entity, key, label, type, required, visible_ia, options)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
    [
      input.tenantId,
      input.entity,
      key,
      input.label.trim(),
      input.type,
      input.required ?? false,
      input.visibleIa ?? true,
      JSON.stringify(options),
    ],
  ).catch((err: Error) => {
    if (err.message.includes('custom_fields_tenant_id_entity_key_key')) {
      throw new Error('Ya existe un campo con ese nombre para esa entidad.');
    }
    throw err;
  });
  return aCampo(r.rows[0]);
}

export async function deleteCustomField(
  client: PoolClient,
  input: { tenantId: string; fieldId: string },
): Promise<void> {
  const r = await client.query('DELETE FROM custom_fields WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.fieldId,
  ]);
  if (r.rowCount === 0) throw new Error('Ese campo no existe en este negocio.');
  // Lo ya guardado en `custom` NO se toca: borrar la definición no puede
  // borrarle datos al negocio sin avisar. Queda como valor suelto hasta que
  // alguien lo edite.
}

/**
 * Valida lo que se quiere guardar contra lo declarado.
 *
 * Solo mira los campos DECLARADOS: lo que el negocio tenga de antes en
 * `custom` sigue pasando, porque si no, declarar un campo nuevo rompería
 * todas las fichas viejas de golpe.
 */
export function validarCustom(
  campos: CampoPersonalizado[],
  valores: Record<string, unknown>,
): Record<string, unknown> {
  const salida: Record<string, unknown> = { ...valores };
  for (const campo of campos) {
    const crudo = valores[campo.key];
    const vacio = crudo === undefined || crudo === null || crudo === '';
    if (vacio) {
      if (campo.required) throw new Error(`Falta "${campo.label}", que es obligatorio.`);
      continue;
    }
    switch (campo.type) {
      case 'numero':
      case 'moneda': {
        const n = Number(crudo);
        if (!Number.isFinite(n)) throw new Error(`"${campo.label}" tiene que ser un número.`);
        salida[campo.key] = n;
        break;
      }
      case 'si_no': {
        if (typeof crudo !== 'boolean') {
          throw new Error(`"${campo.label}" es de sí o no.`);
        }
        break;
      }
      case 'fecha': {
        // El día del NEGOCIO viaja como texto AAAA-MM-DD: una fecha con hora
        // y zona vuelve a traer el problema que ya resolvimos (#182).
        if (typeof crudo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(crudo)) {
          throw new Error(`"${campo.label}" tiene que ser una fecha AAAA-MM-DD.`);
        }
        break;
      }
      case 'lista': {
        if (!campo.options.includes(String(crudo))) {
          throw new Error(`"${campo.label}" acepta: ${campo.options.join(', ')}.`);
        }
        break;
      }
      default:
        salida[campo.key] = String(crudo);
    }
  }
  return salida;
}

/** Lo que el copiloto puede ver: los campos marcados `visible_ia`. */
export function paraLaIa(
  campos: CampoPersonalizado[],
  valores: Record<string, unknown>,
): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  for (const campo of campos) {
    if (!campo.visibleIa) continue;
    const valor = valores[campo.key];
    if (valor !== undefined && valor !== null && valor !== '') salida[campo.label] = valor;
  }
  return salida;
}
