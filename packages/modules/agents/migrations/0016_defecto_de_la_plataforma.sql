-- El proveedor y modelo por tarea de la PLATAFORMA, fuera del código (#858).
--
-- Vivía en `DEFAULT_TASK_MODELS`, en un `.ts`. Moverlo —como el 12-10, cuando
-- el defecto pasó de GLM a OpenAI— era editar el archivo, abrir un PR y
-- esperar un despliegue. La decisión más caliente del producto no puede
-- necesitar eso: el día que un proveedor se cae o se queda sin saldo, el
-- camino de vuelta es media hora de CI.
--
-- SIN `tenant_id`, y es a propósito. El dueño descartó el defecto por tenant
-- el 12-10 —«que yo pueda elegir el modelo default de cada tenant NO TIENE
-- SENTIDO»— y el motivo quedó escrito en #858: un defecto por negocio
-- multiplica las combinaciones que hay que probar (nueve tareas por cuatro
-- proveedores por N negocios) para resolver un problema que nadie tiene, y
-- deja el dataset de regresión midiendo algo que nadie usa. Es del
-- DESPLIEGUE, igual que `plan_limits` y `platform_module_flags`.
--
-- El código sigue siendo la semilla: una tarea sin fila acá usa su valor
-- compilado. Así un despliegue nuevo arranca con lo que el repo dice, y la
-- tabla solo guarda lo que alguien decidió cambiar — que es también lo que
-- hace que la lista de cambios sea legible.
CREATE TABLE IF NOT EXISTS agent_task_defaults (
  task       text PRIMARY KEY,
  provider   text NOT NULL,
  model      text NOT NULL,
  -- `minimo` | `bajo` | `medio` | `alto`, o NULL si esa tarea no lleva dial.
  esfuerzo   text,
  -- Quién lo cambió. Sin FK a `users` a propósito: puede haber sido un
  -- SuperAdmin de la plataforma, que no es usuario de ningún tenant.
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
