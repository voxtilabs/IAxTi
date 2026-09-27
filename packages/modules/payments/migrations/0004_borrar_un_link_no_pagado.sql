-- El trigger de inmutabilidad cancelaba TODO borrado, en silencio (#625).
--
-- `payment_links_immutable()` hacía `RETURN NEW` en un trigger
-- `BEFORE UPDATE OR DELETE`. En un DELETE, `NEW` es NULL, y un trigger BEFORE
-- que devuelve NULL **cancela la operación sin error**: el DELETE reporta cero
-- filas afectadas, como si no hubiera nada que borrar.
--
-- Consecuencias, en orden de cuánto engañan:
--
--   1. Ningún `DELETE FROM payment_links` funcionaba en ninguna parte.
--   2. La limpieza de los tests mentía: creía que borró y no borró. La base de
--      desarrollo compartida acumula filas de cada corrida.
--   3. El día que la política de retención (SPEC §39) tenga que borrar links,
--      no va a borrar nada y va a decir que sí.
--
-- La intención del trigger es correcta y no cambia: un link PAGADO no se toca,
-- ni por UPDATE ni por DELETE, y ahora se niega igual de fuerte —con su
-- excepción y su motivo— en los dos casos. Lo que se arregla es que el mismo
-- `RETURN` servía para dos operaciones donde significa cosas opuestas.
--
-- Aditiva: `CREATE OR REPLACE FUNCTION` sobre la función que ya existe. El
-- trigger no se toca.
CREATE OR REPLACE FUNCTION payment_links_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'paid' THEN
    -- Vale para UPDATE y para DELETE: un link pagado es la constancia de que
    -- alguien pagó. Se niega en voz alta, que es lo contrario de antes.
    RAISE EXCEPTION 'Un link pagado es inmutable.';
  END IF;
  -- En un DELETE hay que devolver OLD. `NEW` es NULL acá, y devolver NULL en un
  -- BEFORE cancela la operación sin decir nada.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
