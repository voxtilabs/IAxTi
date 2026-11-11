-- El proveedor es de la CUENTA, no del despliegue (ADR-0032, #1316).
--
-- Hasta acá el registro de adaptadores tenía la clave por CANAL, así que
-- elegir proveedor era una decisión del despliegue entero: o todos los
-- clientes en Zavu, o todos en otro. Con clientes reales encima eso no es una
-- migración, es un salto al vacío.
--
-- `'zavu'` por omisión y NOT NULL: todo lo que existe hoy queda exactamente
-- igual, que es lo que hace a esta migración aditiva de verdad.
--
-- SIN `CHECK` contra una lista de nombres, a propósito. El registro de
-- adaptadores es estado de PROCESO —`registerProvider` corre al arrancar—, así
-- que la base no puede saber cuáles existen. Un CHECK acá daría la sensación
-- de estar validando y solo congelaría la lista: para agregar un proveedor
-- habría que migrar. Lo que sí hay es una verificación al levantar, que falla
-- si una cuenta declara un proveedor que nadie registró. Esa es la que
-- importa, porque es la que conoce el registro.
ALTER TABLE channel_accounts
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'zavu';

-- Para la verificación del arranque: barre cuentas agrupando por proveedor, y
-- es una lectura que se hace una vez por proceso.
CREATE INDEX IF NOT EXISTS channel_accounts_provider_idx
  ON channel_accounts (provider);

-- Qué proveedores declaran las cuentas, de TODOS los tenants, para la
-- verificación del arranque: una cuenta que declara un proveedor que nadie
-- registró no puede caer en silencio al que esté.
--
-- SECURITY DEFINER por el mismo motivo que `tenant_del_emisor`: la tabla tiene
-- RLS y el arranque no tiene tenant. Devuelve SOLO nombres de proveedor —ni
-- ids, ni tenants, ni datos de cliente—, que es lo único que la verificación
-- necesita y lo único que vale la pena exponer sin tenant.
CREATE OR REPLACE FUNCTION proveedores_de_cuentas()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT provider FROM channel_accounts ORDER BY 1
$$;

REVOKE ALL ON FUNCTION proveedores_de_cuentas() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION proveedores_de_cuentas() TO iaxti_app;
  END IF;
END $$;
