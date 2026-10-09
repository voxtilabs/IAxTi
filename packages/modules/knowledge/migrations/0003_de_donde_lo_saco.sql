-- De dónde sacó la IA lo que dijo (#714).
--
-- Sale de: «¿sería bueno ponerle obsidian? para ver su fuente de
-- conocimientos». La pregunta apunta a algo que faltaba de verdad: las citas
-- del retrieval se armaban, viajaban al modelo y se quedaban ahí. Quien lee una
-- sugerencia no podía ver en qué se apoyó — justo lo que uno se pregunta cuando
-- la respuesta suena rara o cuando un cliente reclama un precio.
--
-- Y una tercera cosa que nadie podía responder: QUÉ FUENTES NO SE USAN NUNCA.
-- Un negocio sube ocho documentos, la IA se apoya en dos, y los otros seis
-- siguen ahí ocupando contexto y costando tokens sin que se sepa.

-- Cuándo se usó por última vez y cuántas veces. Las dos juntas y no una: una
-- fuente usada mil veces hace seis meses y una usada dos veces ayer dicen cosas
-- distintas, y con un solo número las dos se ven igual.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS use_count bigint NOT NULL DEFAULT 0;

-- `NULLS LAST` a propósito: la pregunta que se hace sobre esta tabla es «¿qué
-- sostiene las respuestas?», y las nunca usadas van al final de esa lista. Para
-- la pregunta inversa —«¿qué estoy pagando sin que sirva?»— el `NULL` se filtra
-- con `IS NULL`, que no necesita índice en una tabla de decenas de filas.
CREATE INDEX IF NOT EXISTS sources_tenant_uso_idx
  ON sources (tenant_id, last_used_at DESC NULLS LAST);

-- Los `[[enlaces]]` de los markdown importados.
--
-- `fuenteDesdeMarkdown` los extraía desde el primer día y la ruta de
-- importación los devolvía en la respuesta HTTP, donde nadie los guardaba: el
-- defecto de siempre, declarado en un lado y aplicado en ninguno.
--
-- Guarda el NOMBRE del destino y no su id, y eso es deliberado: cuando se
-- importa una carpeta, `precios.md` puede nombrar `[[despacho]]` antes de que
-- `despacho.md` entre. Un id resuelto en la importación quedaría nulo para
-- siempre; el nombre se resuelve al leer, y el enlace se "enciende" solo cuando
-- el destino aparece. Un enlace que apunta a algo que no existe TAMBIÉN es
-- información: dice que falta un documento.
CREATE TABLE IF NOT EXISTS source_links (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  source_id   uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  target_name text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id, target_name)
);
CREATE INDEX IF NOT EXISTS source_links_tenant_idx ON source_links (tenant_id, source_id);
ALTER TABLE source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_links FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'source_links') THEN
    CREATE POLICY tenant_isolation ON source_links
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
