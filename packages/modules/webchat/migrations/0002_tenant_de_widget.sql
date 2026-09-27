-- El widget del sitio se pide SIN tenant (#370, mismo caso que #286).
--
-- El snippet del chat vive en la página de un cliente y lo único que trae es
-- el id del widget. Ese id ES la credencial pública: con él hay que averiguar
-- de qué negocio es para poder fijar `app.tenant_id`.
--
-- `findWidgetById` lo resolvía con una consulta suelta al pool, y
-- `webchat_widgets` tiene RLS FORCE: con un rol que respete las políticas la
-- consulta corre sin `app.tenant_id`, la política evalúa `tenant_id = NULL` y
-- devuelve cero filas. O sea que **el chat del sitio de cada cliente
-- respondería "Nada por aquí"** — config, sesiones y sondeo, todo. Y con el
-- rol de hoy (superusuario) funciona pero no protege nada: Postgres ni mira
-- las políticas, así que la segunda cerradura del aislamiento no está puesta.
--
-- La salida es la misma que para las API keys y las cuentas de canal: una
-- función SECURITY DEFINER acotada al hueso. Devuelve **solo el tenant** —
-- ni el dominio autorizado, ni el nombre, ni si está activo. Con ese id el
-- llamador entra por `withTenant` y lee el widget completo bajo RLS, que es
-- donde se decide si el dominio calza y si está activo.

CREATE OR REPLACE FUNCTION tenant_de_widget_de_webchat(p_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM webchat_widgets WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION tenant_de_widget_de_webchat(uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenant_de_widget_de_webchat(uuid) TO iaxti_app;
  END IF;
END $$;
