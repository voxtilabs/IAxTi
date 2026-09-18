-- El webhook de pagos llega SIN tenant (#286, continuación).
--
-- Mismo caso que la cuenta de canal: la URL trae el id del proveedor y el
-- tenant es lo que hay que averiguar. `findProviderGlobal` lo resolvía con
-- una consulta suelta y `payment_providers` tiene RLS FORCE — o sea que con
-- el rol de producción **un pago confirmado por Flow no se registraría
-- nunca**: el cliente paga, el proveedor avisa, y no encontramos a quién
-- corresponde.
--
-- Devuelve solo el tenant. La credencial y el modo se leen después, dentro
-- de `withTenant`, que además es donde la guarda de modo live tiene sentido.

CREATE OR REPLACE FUNCTION tenant_de_proveedor_de_pago(p_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM payment_providers WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION tenant_de_proveedor_de_pago(uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenant_de_proveedor_de_pago(uuid) TO iaxti_app;
  END IF;
END $$;
