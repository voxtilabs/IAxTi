-- Lo aprendido de los chats del negocio nace por revisar (#1406, ADR-0039).
--
-- La regla 3 del ADR: la dueña revisa lo aprendido ANTES de que el asistente
-- lo use. Ese «antes» es un estado de la fuente, no una bandera en otra
-- tabla: la búsqueda del asistente ya decide con `FUENTE_VIGENTE`
-- (`s.status = 'active'`), que nació «qué SÍ sirve» y no «qué no» — así que
-- un estado nuevo queda fuera de la búsqueda sin tocar ninguna consulta.
-- El comentario de `search.ts` («nota para quien venga a mejorarla») explica
-- por qué no se reescribe esa constante como lista de exclusiones.
--
-- Mismo movimiento que la 0004, y por lo mismo: el CHECK se REEMPLAZA y no
-- se agrega otro, porque dos CHECK por valor permitido dejan la regla en dos
-- lugares. Es una RELAJACIÓN —acepta todo lo que aceptaba antes y uno más—,
-- así que la versión anterior de la app sigue funcionando con este esquema,
-- que es lo que pide la ventana de compatibilidad.
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_status_check;
ALTER TABLE sources ADD CONSTRAINT sources_status_check
  CHECK (status IN ('processing', 'active', 'expired', 'failed', 'delete_failed', 'por_revisar'));
