-- Centro de IA (#70): el presupuesto de IA por plan, en dólares, que define
-- qué es "fuera de rango". Nace NULL a propósito: sin un número que Lino
-- haya puesto, la alerta informa el gasto y no lo compara contra un
-- presupuesto inventado. Se edita desde el SuperAdmin como el resto del plan.
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS ia_budget_usd numeric(10,2);
