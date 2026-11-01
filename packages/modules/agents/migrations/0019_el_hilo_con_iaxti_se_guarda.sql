-- El hilo con el Agente General, guardado (#1131, ADR-0029).
--
-- ## Qué cambia y por qué se revisó
--
-- `agente-general.controller.ts` decía textual que no guardar el hilo «es a
-- propósito — una conversación de configuración no es un dato del negocio que
-- haya que retener». Era correcto cuando el agente era un popup que se abría
-- y se cerraba: nadie esperaba volver.
--
-- #1135 lo convirtió en la pantalla «Tu asistente», y el dueño del producto
-- pidió «ver mis anteriores conversaciones». No hay historial con un hilo en
-- memoria, así que pedir la función es elegir guardarlo.
--
-- ## El caso que lo justifica, que no es la comodidad
--
-- El agente PROPONE acciones y el humano las aprueba (ADR-0025, ADR-0017).
-- Una propuesta sin resolver que desaparece en una recarga deja al dueño sin
-- saber qué le habían ofrecido: no pierde una conversación, pierde una
-- decisión pendiente, y ni se entera de que la tenía. Eso ya es un
-- compromiso del producto con él, y los compromisos se guardan.
--
-- ## La forma
--
-- Los turnos van en `jsonb` y no en una tabla de mensajes. Lo que se guarda es
-- el hilo COMPLETO tal como se vuelve a dibujar —con sus pasos y sus
-- propuestas resueltas o no—, se reemplaza entero en cada vuelta y nunca se
-- consulta por dentro. Una tabla hija daría consultas que nadie va a escribir
-- y un borrado en dos pasos que nadie necesita.
CREATE TABLE IF NOT EXISTS agent_general_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- De quién es: el hilo es personal. Dos personas del mismo negocio
  -- configurando a la vez no se pisan, y lo que una le contó al agente no
  -- aparece en la pantalla de la otra.
  user_id uuid NOT NULL,
  -- Lo primero que dijo la persona, recortado. Es el rótulo de la
  -- conversación en la lista: generarlo con el modelo costaría una llamada
  -- por conversación para nombrar algo que el usuario ya nombró al escribir.
  titulo text NOT NULL,
  turnos jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Sin `created_at`: la escribí y ninguna consulta la devolvía, y el
  -- trinquete de columnas sin lector (#703) lo cazó. Lo que la lista muestra
  -- y lo que la retención mira es `updated_at`. El día que alguien necesite
  -- «cuándo empezó esta conversación», que la agregue CON su lector.
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Empieza por `tenant_id`, como toda tabla de negocio. El segundo y el tercero
-- son cómo se lee de verdad: las conversaciones de ESTA persona, la más
-- reciente primero.
CREATE INDEX IF NOT EXISTS agent_general_threads_tenant_user_idx
  ON agent_general_threads (tenant_id, user_id, updated_at DESC);

ALTER TABLE agent_general_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_general_threads FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_general_threads') THEN
    CREATE POLICY tenant_isolation ON agent_general_threads
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- La retención: 30 días sin tocarla y se va (ADR-0029). Un ciclo de
-- configuración entra holgado y no se vuelve un archivo histórico de lo que
-- el dueño contó de su negocio.
--
-- Va como comentario de columna y no solo en el código del barrido para que
-- el día que alguien mire la tabla sepa que caduca, sin tener que buscar
-- quién la borra.
COMMENT ON COLUMN agent_general_threads.updated_at IS
  'Retención: el barrido borra los hilos sin actividad por más de 30 días (ADR-0029).';
