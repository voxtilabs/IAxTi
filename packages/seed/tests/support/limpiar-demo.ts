import type { Pool } from 'pg';

/**
 * Deja el tenant demo como si nunca hubiera existido.
 *
 * Los dos archivos de prueba de este paquete son dueños del MISMO tenant:
 * los dos lo borran y lo vuelven a sembrar. Cada uno tenía su propia lista
 * de tablas y una estaba incompleta, así que —según el orden en que
 * corrieran— aparecía un fallo que no tiene nada que ver con lo que se
 * está probando: «Ya existe un atajo "precios"», o la clave foránea de
 * `contacts` al borrar el tenant.
 *
 * La lista no se escribe a mano: se pregunta. Cada módulo nuevo trae sus
 * tablas colgando de `tenants`, y una lista escrita acá se queda vieja
 * justo cuando alguien agrega un módulo y no entiende por qué falla el
 * seed.
 *
 * Se borra en vueltas: lo que no se deja borrar todavía es porque algo lo
 * apunta, y ese algo se borra en la vuelta anterior o en la siguiente.
 */
export async function limpiarDemo(admin: Pool, nombre: string): Promise<void> {
  const previo = await admin.query('SELECT id FROM tenants WHERE name = $1', [nombre]);
  if ((previo.rowCount ?? 0) === 0) return;
  const id = previo.rows[0].id as string;

  // El audit es append-only por trigger: para borrarlo hay que apagarlo, y
  // por eso esta limpieza vive solo en las pruebas.
  await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [id]);
  await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');

  const r = await admin.query<{ tabla: string }>(
    `SELECT DISTINCT conrelid::regclass::text AS tabla
       FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'tenants'::regclass
        AND conrelid <> 'tenants'::regclass`,
  );
  // `audit_log` ya se fue arriba y su trigger rechaza cualquier DELETE:
  // dejarlo en la lista haría que las vueltas nunca terminen limpias.
  let pendientes = r.rows.map((f) => f.tabla).filter((t) => t !== 'audit_log');
  let huboAvance = true;
  while (pendientes.length > 0 && huboAvance) {
    const quedaron: string[] = [];
    for (const tabla of pendientes) {
      try {
        await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [id]);
      } catch {
        // Algo la apunta todavía: va a salir en una vuelta siguiente.
        quedaron.push(tabla);
      }
    }
    // El corte es el AVANCE, no un número de vueltas: las cadenas de
    // claves foráneas son tan largas como el esquema, y contar vueltas
    // dejaba tablas sin borrar justo cuando quedaban pocas.
    huboAvance = quedaron.length < pendientes.length;
    pendientes = quedaron;
  }

  await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
}
