-- ¿El agente logra su objetivo? (#319)
--
-- Hasta acá se medía cuántas ejecuciones, cuántos tokens y cuánto costó. Nada
-- de eso responde lo único que el dueño se pregunta: ¿esto me sirve?
--
-- Un intento por conversación: se abre cuando el agente actúa por primera vez
-- con un objetivo, y se cierra con el evento que corresponde.
CREATE TABLE IF NOT EXISTS agent_goal_attempts (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL,
  agent_id        uuid REFERENCES agents(id),
  objetivo        text NOT NULL
                  CHECK (objetivo IN ('agendar','vender','informar','calificar','cobrar')),
  objetivo_detalle text,
  -- El contacto se guarda ACÁ a propósito, aunque viva en `conversations`.
  -- Los eventos de éxito traen contactId y no conversationId, así que la
  -- atribución los cruza por contacto: sin esta columna habría que consultar
  -- la tabla de otro módulo en cada evento, que es justo lo que no se hace.
  contact_id      uuid NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  outcome         text NOT NULL DEFAULT 'pendiente'
                  CHECK (outcome IN ('pendiente','logrado','perdido')),
  -- CÓMO se logró, y esto es lo que no se puede omitir:
  --
  --   'agente'   → el agente ejecutó la tool que produjo el resultado. Es un
  --                HECHO: quedó en agent_executions.
  --   'asistida' → el agente trabajó la conversación y una PERSONA cerró.
  --                Es una INFERENCIA: mismo contacto, dentro de la ventana.
  --
  -- Dos de los cinco objetivos el agente no los cierra él (ADR-0017): en
  -- agendar ofrece horarios y una persona toma la hora; en cobrar una persona
  -- manda el link. Sumar las dos cosas en un solo número exagera lo que hace
  -- el agente, y el valor entero de esta métrica es que el dueño le crea.
  atribucion      text CHECK (atribucion IN ('agente','asistida')),
  achieved_at     timestamptz,
  achieved_event  text,        -- appointment.created | deal.created | …
  achieved_ref    uuid,        -- el id de la cita, el trato o el pago
  closed_at       timestamptz, -- cuándo se cerró la conversación sin lograrlo
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id)
);
-- Por contacto: es como entra la atribución asistida, que llega por evento y
-- solo sabe de quién es, no de qué conversación.
CREATE INDEX IF NOT EXISTS agent_goal_attempts_contacto_idx
  ON agent_goal_attempts (tenant_id, contact_id, outcome, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_goal_attempts_agente_idx
  ON agent_goal_attempts (tenant_id, agent_id, started_at DESC);
ALTER TABLE agent_goal_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_goal_attempts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_goal_attempts') THEN
    CREATE POLICY tenant_isolation ON agent_goal_attempts
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
