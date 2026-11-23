-- El envío desde la bandeja a todos los que conversaron (#1247).
--
-- Cerrar el stand de una feria y decirle «gracias, acá quedamos» a las 31
-- personas que escribieron no tenía pantalla: se hizo con un script contra la
-- base. Una difusión es eso — el mismo texto a las conversaciones de WhatsApp
-- cuyo último entrante cae dentro de la ventana de 24 h.
--
-- Dos tablas porque el envío son DOS actos: la previsualización, que congela
-- a quién le llegaría y se muestra ANTES de mandar nada, y el envío mismo,
-- que recalcula (alguien pudo darse de baja entremedio) y crea un mensaje por
-- destinatario. La previsualización persiste a propósito: «manda a los de la
-- previa» necesita que la previa sea algo más que una respuesta HTTP que ya
-- nadie recuerda, y el resultado por destinatario se lee después, cuando el
-- canal ya contestó.

CREATE TABLE IF NOT EXISTS difusiones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  -- El texto EXACTO que se mostró en la previsualización. Un WhatsApp no se
  -- puede deshacer: lo que se mandó tiene que quedar escrito en la base.
  texto      text NOT NULL,
  -- El filtro elegido ({estado?, etiquetaId?}): lo que definió el conjunto.
  filtro     jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado     text NOT NULL DEFAULT 'previa'
             CHECK (estado IN ('previa', 'enviada')),
  -- El resumen de la previsualización: cuántos quedaron fuera y por qué, y si
  -- el envío caía en horario de silencio. Es lo que se mostró; enviar muestra
  -- el recálculo.
  previa     jsonb NOT NULL DEFAULT '{}'::jsonb,
  total      int,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  enviada_at timestamptz
);
CREATE INDEX IF NOT EXISTS difusiones_tenant_idx ON difusiones (tenant_id, created_at DESC);
ALTER TABLE difusiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE difusiones FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'difusiones') THEN
    CREATE POLICY tenant_isolation ON difusiones
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Un destinatario por conversación: el mensaje que se le creó (null si el
-- recálculo del envío lo dejó fuera) y, en ese caso, por qué.
CREATE TABLE IF NOT EXISTS difusion_destinatarios (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  difusion_id     uuid NOT NULL REFERENCES difusiones(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  -- ON DELETE SET NULL: la supresión del titular (#235) borra sus mensajes,
  -- y una difusión que lo apuntaba NO puede bloquear eso — sin esto el borrado
  -- que pide la ley reventaba con una violación de llave foránea. El
  -- destinatario queda como «hubo un envío, el mensaje ya no existe».
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- Por qué NO entró al enviar (recálculo sobre la lista de la previa):
  -- 'se dio de baja', 'ventana cerrada', 'es del equipo'. Null si entró.
  excluido        text,
  -- Cuántos mensajes se le crearon a esta persona por esta difusión: uno al
  -- enviar, uno más por cada reintento de los fallidos.
  intentos        int NOT NULL DEFAULT 0,
  PRIMARY KEY (difusion_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS difusion_destinatarios_tenant_idx
  ON difusion_destinatarios (tenant_id, difusion_id);
ALTER TABLE difusion_destinatarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE difusion_destinatarios FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'difusion_destinatarios') THEN
    CREATE POLICY tenant_isolation ON difusion_destinatarios
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
