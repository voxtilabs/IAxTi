-- #902: /me conoce al usuario autenticado, todavía no al tenant.
-- Segunda cerradura por usuario, SOLO de lectura y SOLO sin tenant elegido.
-- El backend fija app.user_id con SET LOCAL desde el JWT validado; nunca desde
-- query/body ni desde el navegador. Ni SECURITY DEFINER ni BYPASSRLS.
-- Dentro de withTenant sigue rigiendo exclusivamente la política por tenant.
-- La búsqueda inicial es por usuario, sin un tenant que aproveche la PK compuesta.
CREATE INDEX IF NOT EXISTS user_roles_user_idx ON user_roles(user_id);

CREATE POLICY membresias_de_la_sesion ON user_roles
  FOR SELECT
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Permite leer el nombre de SU rol propio sin abrir los roles de otros negocios.
CREATE POLICY rol_de_la_sesion ON roles
  FOR SELECT
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    AND EXISTS (
      SELECT 1 FROM user_roles ur
       WHERE ur.role_id = roles.id
         AND ur.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );
