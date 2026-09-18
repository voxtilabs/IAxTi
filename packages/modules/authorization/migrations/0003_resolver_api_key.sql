-- Resolver una API key es un paso ANTERIOR a saber el tenant (#286).
--
-- `resolveApiKey` buscaba en `api_keys` con una consulta suelta al pool.
-- Esa tabla tiene RLS, así que con el rol de producción devuelve cero filas
-- y NINGUNA petición autenticada por API key pasaría. En desarrollo no se
-- veía: el rol es superusuario y Postgres ni mira las políticas.
--
-- Acá no sirve el patrón del resto de los barridos —recorrer tenants— porque
-- el tenant es precisamente lo que se está averiguando, y hacerlo por
-- petición sería O(tenants) en cada request.
--
-- La salida es una función SECURITY DEFINER, que es la respuesta estándar de
-- Postgres a "esta consulta puntual necesita ver más que quien la llama".
-- Se acota a propósito:
--
--   * Entra un HASH. Sin el hash de un token válido no devuelve nada, así
--     que no sirve para recorrer la tabla.
--   * Sale UNA fila con id, tenant y scopes. Ni el hash, ni el nombre, ni
--     nada de los demás tenants.
--   * `SET search_path = public` — sin esto, quien controle el search_path
--     puede hacer que la función llame a otra cosa.
--   * El EXECUTE se concede explícitamente; no queda abierto a PUBLIC.
--
-- Es el único agujero de este tipo en el sistema, y está acá para que se lo
-- pueda auditar leyendo un archivo.

CREATE OR REPLACE FUNCTION resolver_api_key(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, scopes jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT k.id, k.tenant_id, k.scopes
      FROM api_keys k
     WHERE k.key_hash = p_hash
       AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now());

  -- El último uso se estampa como mucho una vez por minuto: sirve para
  -- saber si una key sigue viva, no para contar peticiones.
  UPDATE api_keys k SET last_used_at = now()
   WHERE k.key_hash = p_hash
     AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute');
END;
$$;

REVOKE ALL ON FUNCTION resolver_api_key(text) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION resolver_api_key(text) TO iaxti_app;
  END IF;
END $$;
