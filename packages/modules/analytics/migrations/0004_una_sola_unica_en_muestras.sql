-- Una sola única en response_samples (#748, segundo intento).
--
-- El primer arreglo movió el árbitro del `ON CONFLICT` de la clave primaria
-- compuesta a la única de `conversation_id`. El rojo cambió de nombre y no se
-- fue: pasó de `response_samples_conversation_id_key` a `response_samples_pkey`.
--
-- Y eso dice exactamente qué pasa. `ON CONFLICT` protege UN índice: hace una
-- inserción especulativa en el que se le nombra y espera al que esté a medias.
-- En los demás índices únicos no hay nada de eso — se inserta y, si otra
-- transacción se adelantó y confirmó, LANZA. Así que con dos únicas que se
-- pisan, cualquiera de las dos orientaciones está rota bajo concurrencia: la
-- que no es árbitro es la que te va a tirar el error.
--
-- La tabla tenía las dos: `PRIMARY KEY (tenant_id, conversation_id)` y
-- `conversation_id UNIQUE`. La segunda es redundante: el id de una conversación
-- es único en toda la base y la muestra copia el `tenant_id` de SU conversación,
-- así que no hay forma de que la misma conversación aparezca bajo dos tenants.
-- Estaba cuidando algo que el esquema ya hacía imposible, y a cambio rompía la
-- idempotencia que el barrido necesita.
--
-- Se va la única y queda un índice común en su lugar: las búsquedas y los
-- borrados por conversación —`retention.ts`, los derechos del titular— seguían
-- usando ese índice, y perderlo sería cambiar un problema por otro.
ALTER TABLE response_samples DROP CONSTRAINT IF EXISTS response_samples_conversation_id_key;
CREATE INDEX IF NOT EXISTS response_samples_conversation_idx
  ON response_samples (conversation_id);
