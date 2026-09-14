-- Autorización de Supabase Realtime para la bandeja (#37, SPEC §40):
-- el canal privado tenant:<id>:bandeja solo lo escucha quien pertenece al
-- tenant. Todo va guardado por IF EXISTS: en Postgres pelado (local y CI)
-- no hay schema realtime ni rol authenticated, y esta migración no hace nada.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Un usuario puede leer SU propia fila de user_roles (además de la
    -- política por tenant): lo necesita la política de realtime.messages
    -- para verificar pertenencia con auth.uid().
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'user_roles' AND policyname = 'user_roles_self'
    ) THEN
      EXECUTE $pol$
        CREATE POLICY user_roles_self ON public.user_roles
          FOR SELECT TO authenticated
          USING (user_id = (SELECT auth.uid()))
      $pol$;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'realtime' AND tablename = 'messages'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'realtime' AND tablename = 'messages' AND policyname = 'bandeja_broadcast'
    ) THEN
      EXECUTE $pol$
        CREATE POLICY bandeja_broadcast ON realtime.messages
          FOR SELECT TO authenticated
          USING (
            realtime.messages.extension = 'broadcast'
            AND EXISTS (
              SELECT 1 FROM public.user_roles ur
              WHERE ur.user_id = (SELECT auth.uid())
                AND realtime.topic() = 'tenant:' || ur.tenant_id::text || ':bandeja'
            )
          )
      $pol$;
    END IF;
  END IF;
END $$;
