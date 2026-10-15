import type { PoolClient } from 'pg';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';

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

/**
 * Dónde vive el `custom` de cada entidad, para poder contar a cuántas fichas
 * les quita el piso un borrado.
 *
 * Es un mapa literal y no el nombre que venga en el input a propósito: el
 * nombre de la tabla se interpola en el SQL —no hay parámetro de Postgres
 * para un identificador—, así que lo único interpolable tiene que ser uno de
 * estos tres valores escritos acá. El `key` sí viaja como parámetro.
 *
 * Las tres entradas se ejercitan en `tests/campos.test.ts` («la cuenta mira
 * la tabla de ESA entidad»), con la misma llave declarada en las tres: un
 * nombre de tabla equivocado acá no da un número raro, da un error de
 * Postgres o el conteo de otra entidad.
 */
const TABLA_DE_ENTIDAD: Record<EntidadConCampos, string> = {
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
};

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

/**
 * Quién hizo esto, en un par que no se contradiga.
 *
 * Existe porque el par por defecto decía dos cosas distintas: `actor` caía en
 * `'system'` y `actorKind` en `'user'`, así que el libro quedaba afirmando
 * que un USUARIO llamado «system» declaró el campo — y eso es peor que no
 * saber, porque se lee como un dato. Sin actor no hubo persona: el tipo es
 * `'system'`.
 *
 * Con actor y sin tipo, `'user'`: el único camino que manda actor sin tipo es
 * una llamada interna con el id de quien pidió. Los controladores mandan los
 * dos (`apikey` cuando entra por API key).
 */
function quienFue(input: { actor?: string; actorKind?: ActorKind }): {
  actor: string;
  actorKind: ActorKind;
} {
  if (!input.actor) return { actor: 'system', actorKind: input.actorKind ?? 'system' };
  return { actor: input.actor, actorKind: input.actorKind ?? 'user' };
}

/**
 * La definición del campo tal como queda escrita en el libro: TODO lo que
 * tiene `CampoPersonalizado` menos el id, que ya viaja en `resourceId`.
 *
 * Es una función y no un objeto escrito en cada `writeAudit` para que
 * «completa» siga siendo cierto cuando alguien agregue una columna: si
 * mañana el campo gana una bandera, se agrega acá y las tres acciones la
 * registran. `options` entra por lo mismo que el resto — las opciones de una
 * lista son parte de qué era el campo, y después de borrarlo no quedan en
 * ningún lado.
 */
function definicion(campo: CampoPersonalizado): Record<string, unknown> {
  return {
    entity: campo.entity,
    key: campo.key,
    label: campo.label,
    type: campo.type,
    required: campo.required,
    visibleIa: campo.visibleIa,
    options: campo.options,
  };
}

/**
 * La mitad editable de la definición, que es la que tiene sentido mostrar en
 * un antes/después: `entity`, `key` y `type` no se pueden cambiar (ver
 * `updateCustomField`), y repetirlas en los dos lados haría creer que sí.
 */
function loEditable(campo: CampoPersonalizado): Record<string, unknown> {
  return {
    label: campo.label,
    required: campo.required,
    visibleIa: campo.visibleIa,
    options: campo.options,
  };
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

/**
 * Declarar un campo es una decisión del negocio, no un detalle de forma, y
 * hasta #534 no dejaba rastro: el archivo entero no tenía un solo
 * `writeAudit`. Dos de estas banderas cambian lo que el producto hace con los
 * datos de personas —`required` le exige el dato a quien carga la ficha y
 * `visibleIa` decide si sale hacia el asistente (#528)—, así que «quién
 * declaró este campo y cuándo» es justo lo que un libro de auditoría tiene
 * que poder contestar, y no podía.
 *
 * La entrada de auditoría va DESPUÉS del INSERT y dentro de la misma
 * transacción de `withTenant`, que es lo que pide CLAUDE.md §3: si el INSERT
 * choca con la llave única, el throw hace ROLLBACK y no queda ni el campo ni
 * el registro de que se creó. Por lo mismo, los rechazos de acá arriba
 * —entidad desconocida, tipo desconocido, lista sin opciones— NO se auditan:
 * una fila escrita antes del throw se iría con el ROLLBACK, y auditar un
 * intento fallido tendría que hacerse fuera de esta transacción.
 */
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
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
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
  const campo = aCampo(r.rows[0]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    ...quienFue(input),
    action: 'fields.create',
    resource: 'custom_field',
    // El id lo genera la base en el INSERT: que esté acá es lo que prueba
    // que esta escritura va DESPUÉS de la mutación y no antes.
    resourceId: campo.id,
    result: 'ok',
    requestId: input.requestId,
    // Lo que hace falta para reconstruir la decisión sin ir a mirar la tabla
    // —que para entonces puede estar borrada—. `visibleIa` es el que más
    // importa: es el que cambia qué información del negocio sale hacia la IA.
    metadata: definicion(campo),
  });
  return campo;
}

/**
 * Cambiar un campo ya declarado (#534).
 *
 * El issue lo nombra en el título —«crear, EDITAR o borrar»— y su primer
 * criterio pide que la edición reciba actor y audite. De las tres, era la
 * única que ni siquiera existía: se podía declarar un campo y quitarlo, no
 * corregirlo. O sea que marcar mal «visible para la IA» al declararlo
 * obligaba a borrar el campo y volver a crearlo, y borrar es justo la
 * operación que deja a las fichas con el valor suelto. Arreglar la
 * auditoría de una edición que no se puede hacer no cierra el criterio: lo
 * deja sin sujeto.
 *
 * Lo editable es `label`, `required`, `visibleIa` y `options`. Lo que NO se
 * puede cambiar, con su motivo:
 *
 * - `key`: es la llave con la que el valor está guardado en el `custom` de
 *   cada ficha. Cambiarla dejaría el dato de todas las fichas colgando de un
 *   nombre que ya no existe —perdido sin avisar—, que es exactamente lo que
 *   `deleteCustomField` se cuida de no hacer. Por eso cambiar la ETIQUETA no
 *   recalcula la llave: la etiqueta es lo que se lee, la llave es dónde está
 *   el dato.
 * - `type` y `entity`: el valor que ya está guardado se validó contra el
 *   tipo viejo y vive en la tabla de esa entidad. Cambiarlos convertiría
 *   datos buenos en datos que `validarCustom` rechaza, en fichas que nadie
 *   está mirando.
 */
export async function updateCustomField(
  client: PoolClient,
  input: {
    tenantId: string;
    fieldId: string;
    label?: string;
    required?: boolean;
    visibleIa?: boolean;
    options?: string[];
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
): Promise<CampoPersonalizado> {
  // `FOR UPDATE` porque esto es leer-modificar-escribir y el «antes» que se
  // registra tiene que ser el que de verdad había: sin el candado, dos
  // ediciones a la vez pueden leer el mismo estado viejo y dejar dos entradas
  // que dicen que partieron del mismo lado. El libro contaría una historia
  // que no pasó. Dura lo que dura la transacción de `withTenant`.
  const previo = await client.query(
    'SELECT * FROM custom_fields WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [input.tenantId, input.fieldId],
  );
  if (previo.rowCount === 0) throw new Error('Ese campo no existe en este negocio.');
  const antes = aCampo(previo.rows[0]);

  const label = input.label === undefined ? antes.label : input.label.trim();
  if (!label) throw new Error('El campo necesita un nombre.');
  const options =
    input.options === undefined
      ? antes.options
      : input.options.map((o) => String(o).trim()).filter(Boolean);
  // Mismo rechazo que al declararlo: una lista sin opciones no se puede
  // llenar. Dejarla vacía por edición sería la misma ruta al mismo campo
  // inservible, entrando por la puerta de al lado.
  if (antes.type === 'lista' && options.length === 0) {
    throw new Error('Un campo de lista necesita sus opciones.');
  }

  const r = await client.query(
    `UPDATE custom_fields SET label = $3, required = $4, visible_ia = $5, options = $6::jsonb
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [
      input.tenantId,
      input.fieldId,
      label,
      input.required ?? antes.required,
      input.visibleIa ?? antes.visibleIa,
      JSON.stringify(options),
    ],
  );
  const campo = aCampo(r.rows[0]);

  // Se escribe aunque no haya cambiado nada, y es a propósito: «alguien abrió
  // esto y lo dejó igual» es una respuesta, y decidir no registrarlo obligaría
  // a comparar objetos acá para ahorrar una fila.
  await writeAudit(client, {
    tenantId: input.tenantId,
    ...quienFue(input),
    action: 'fields.update',
    resource: 'custom_field',
    resourceId: campo.id,
    result: 'ok',
    requestId: input.requestId,
    // `entity` y `key` una sola vez —no cambian— y el resto en antes/después,
    // porque en una edición la pregunta no es qué quedó sino qué se movió:
    // «`visibleIa` pasó de false a true» es el renglón que alguien va a venir
    // a buscar.
    metadata: {
      entity: campo.entity,
      key: campo.key,
      antes: loEditable(antes),
      despues: loEditable(campo),
    },
  });
  return campo;
}

/**
 * Quitar la definición de un campo propio.
 *
 * Es el borrado que más necesitaba rastro y era el que no tenía ninguno
 * (#534): el campo puede guardar datos personales, y una vez quitada la
 * definición no queda en la base ni cómo se llamaba. De ahí que el metadata
 * repita la definición entera —la que arma `definicion()`: todo lo que tenía
 * la fila menos el id— en vez de solo el id: un id que ya no resuelve a nada
 * no contesta «qué era el campo Convenio».
 *
 * `fichasConValor` es la otra mitad de la respuesta. «Se borró el campo
 * Convenio» no dice si el negocio perdió de vista el dato de 3 fichas o de
 * 3.000, y esa diferencia es la que decide si hay que avisarle a alguien.
 */
export async function deleteCustomField(
  client: PoolClient,
  input: {
    tenantId: string;
    fieldId: string;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
  },
): Promise<void> {
  const r = await client.query(
    'DELETE FROM custom_fields WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [input.tenantId, input.fieldId],
  );
  if (r.rowCount === 0) throw new Error('Ese campo no existe en este negocio.');
  const campo = aCampo(r.rows[0]);

  // Lo ya guardado en `custom` NO se toca: borrar la definición no puede
  // borrarle datos al negocio sin avisar. Queda como valor suelto hasta que
  // alguien lo edite.
  //
  // La cuenta va después del DELETE porque la llave con la que se cuenta sale
  // de la fila borrada (`RETURNING *`): antes no se sabe cuál es el campo.
  // Puede ir después sin mentir porque el DELETE es de `custom_fields` y esto
  // lee la tabla de la entidad —el número no lo movió el borrado—, y las dos
  // van en la misma transacción: si algo falla más abajo, no queda ni el
  // borrado ni el número.
  const conValor = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${TABLA_DE_ENTIDAD[campo.entity]}
      WHERE tenant_id = $1 AND coalesce(custom ->> $2, '') <> ''`,
    [input.tenantId, campo.key],
  );

  await writeAudit(client, {
    tenantId: input.tenantId,
    ...quienFue(input),
    action: 'fields.delete',
    resource: 'custom_field',
    resourceId: campo.id,
    result: 'ok',
    requestId: input.requestId,
    metadata: { ...definicion(campo), fichasConValor: conValor.rows[0].n },
  });
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
