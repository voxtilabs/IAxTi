-- El objetivo final del agente (#315).
--
-- Un agente se configuraba con una caja de texto: personalidad, prompt y una
-- lista de herramientas a curar a mano. El objetivo amarra las tres cosas que
-- estaban sueltas —qué tools necesita, qué tiene que lograr, y qué cuenta
-- como logrado— y hace que la configuración sea una decisión de negocio en
-- vez de un ejercicio de redacción.
--
-- Nullable a propósito: los agentes que ya existen siguen funcionando igual.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS objetivo text;
-- La palabra del negocio: "una visita a terreno", "una reunión por Meet".
-- Va aparte porque agendar una reunión y agendar una visita son el MISMO
-- objetivo: mismas tools, mismo evento de éxito, misma regla de escalamiento.
-- Lo único que cambia son las palabras.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS objetivo_detalle text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_objetivo_ck') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_objetivo_ck
      CHECK (objetivo IS NULL OR objetivo IN ('agendar','vender','informar','calificar','cobrar'));
  END IF;
END $$;
