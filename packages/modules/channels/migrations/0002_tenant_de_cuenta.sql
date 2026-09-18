-- El webhook de entrada llega SIN tenant (#286, continuación).
--
-- La URL del webhook trae el id de la cuenta de canal y nada más: el tenant
-- es justamente lo que hay que averiguar para poder fijar `app.tenant_id`.
-- `findAccountById` lo resolvía con una consulta suelta al pool, y
-- `channel_accounts` tiene RLS FORCE: con el rol de producción devuelve cero
-- filas y **cada mensaje entrante respondería "Nada por aquí"**.
--
-- En desarrollo no se veía porque el rol es superusuario. El comentario del
-- código incluso lo daba por hecho: "el pool del proceso no está bajo RLS".
-- Eso es cierto hoy y falso el día que se conecte el rol de la aplicación.
--
-- La salida es la misma que para las API keys: una función SECURITY DEFINER
-- acotada al hueso. Devuelve **solo el tenant**, nada más — ni la
-- credencial, ni el estado, ni el nombre. Con ese id el llamador entra por
-- `withTenant` y lee la cuenta completa bajo RLS, como corresponde.

CREATE OR REPLACE FUNCTION tenant_de_cuenta_de_canal(p_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM channel_accounts WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION tenant_de_cuenta_de_canal(uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenant_de_cuenta_de_canal(uuid) TO iaxti_app;
  END IF;
END $$;
