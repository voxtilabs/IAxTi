-- Aceptar una invitación pasa ANTES de pertenecer a un tenant (#370).
--
-- Quien canjea el enlace `/invitacion/<token>` todavía no es miembro de nada:
-- eso es exactamente lo que la invitación crea. No hay `app.tenant_id` que
-- fijar porque el tenant es lo que se está averiguando, y el token es lo
-- único que se tiene.
--
-- Por eso la ruta corría con una conexión suelta. Pero `invitations` tiene
-- RLS FORCE, así que con un rol que respete las políticas ese SELECT devuelve
-- cero filas y la respuesta es «Esa invitación no existe. Pide que te inviten
-- de nuevo.» — en el primer momento de un empleado en el producto, sin nada
-- que se pueda arreglar del otro lado. Y si la lectura pasara, el INSERT en
-- `user_roles` chocaría con su WITH CHECK.
--
-- Tampoco sirve recorrer los tenants: sería O(tenants) por intento y el token
-- ya dice cuál es. La salida es la de siempre acá: una función SECURITY
-- DEFINER acotada.
--
--   * Entra el TOKEN (24 bytes al azar). Sin uno válido no devuelve nada, así
--     que no sirve para recorrer la tabla ni para preguntar por un correo.
--   * Sale SOLO el tenant. Ni el rol de la invitación, ni el correo, ni si
--     está vencida o ya usada — eso lo lee `acceptInvitation` dentro de
--     `withTenant`, bajo RLS, y ahí decide.
--   * `SET search_path = public`: sin esto, quien controle el search_path
--     puede hacer que la función llame a otra cosa.
--   * El EXECUTE se concede explícitamente; no queda abierto a PUBLIC.

CREATE OR REPLACE FUNCTION tenant_de_invitacion(p_token text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM invitations WHERE token = p_token
$$;

REVOKE ALL ON FUNCTION tenant_de_invitacion(text) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenant_de_invitacion(text) TO iaxti_app;
  END IF;
END $$;
