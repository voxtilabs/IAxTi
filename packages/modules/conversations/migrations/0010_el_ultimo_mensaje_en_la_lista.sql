-- El último mensaje, para que la lista de la bandeja diga algo.
--
-- La fila de la bandeja mostraba el nombre y, debajo, el teléfono otra vez.
-- Un inbox sin la última línea de la conversación no se puede leer de un
-- vistazo: hay que abrir cada una para saber de qué va.
--
-- Por qué una columna y no un JOIN: la lista pide hasta cien conversaciones y
-- el último mensaje de cada una es un LATERAL por fila. Denormalizar acá cuesta
-- 160 caracteres por conversación y lo mantiene el mismo trigger que ya toca
-- `last_message_at`, dentro de la misma transacción y bajo la misma RLS.
--
-- OJO, y es lo que obliga a tocar dos archivos más: esto es una SEGUNDA COPIA
-- del contenido del cliente. El derecho de supresión (#235) borra el contenido
-- en todas las tablas donde vive, y ya hubo una vez en que una copia derivada
-- se quedó atrás. `suprimirDatosDelTitular` ya ponía `summary = NULL` por lo
-- mismo; esta columna entra en esa misma línea. La purga por retención no
-- necesita cambio: borra la fila entera.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_preview text;

-- El mismo trigger de siempre, con una asignación más.
--
-- `body` viene NULL en lo que no es texto (una imagen, un audio). Se guarda
-- NULL y no el preview anterior: el último mensaje ES la imagen, y mostrar el
-- texto de antes sería decir que lo último que dijo el cliente es algo que no
-- dijo recién. La interfaz decide qué poner cuando no hay texto.
CREATE OR REPLACE FUNCTION conversations_touch_from_message() RETURNS trigger AS $$
BEGIN
  UPDATE conversations SET
    last_message_at = NEW.created_at,
    last_message_preview = NULLIF(left(NEW.body, 160), ''),
    last_inbound_at = CASE WHEN NEW.direction = 'in' THEN NEW.created_at ELSE last_inbound_at END,
    updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Relleno de lo que ya existe, para que la bandeja no quede medio vacía hasta
-- que llegue un mensaje nuevo a cada conversación.
--
-- Es un recorrido por conversación con una búsqueda de su último mensaje. En
-- una base grande no es gratis, y por eso va acá: las migraciones corren con
-- lock ANTES del despliegue, no al arrancar el contenedor.
UPDATE conversations c
   SET last_message_preview = (
         SELECT NULLIF(left(m.body, 160), '')
           FROM messages m
          WHERE m.conversation_id = c.id AND m.body IS NOT NULL
          ORDER BY m.created_at DESC
          LIMIT 1)
 WHERE c.last_message_preview IS NULL;
