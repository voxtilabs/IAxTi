-- Fuente viva, archivo destruido (#631).
--
-- `deleteSource` borra el archivo de R2 DENTRO de la transacción y lanza si el
-- bucket falla, para que la fila vuelva y la persona pueda reintentar (#630).
-- Esa decisión es la correcta: la falla inversa —fila borrada, archivo todavía
-- bajable con una URL firmada— es una fuga que nadie puede ver.
--
-- Pero deja un hueco: si el borrado en R2 sale BIEN y el COMMIT falla después,
-- la fila vuelve y los bytes ya no están. Un estado que antes no existía:
-- **fuente viva, archivo destruido**. Y es justo el que `elCacheSigueSirviendo`
-- no puede ver —pregunta si la fuente existe y está vigente, y la respuesta es
-- sí—, así que el copiloto sigue citando un PDF que nadie puede bajar, con la
-- bendición explícita del chequeo de frescura. Quien siga la cita se queda
-- esperando un archivo que no está.
--
-- El estado nuevo lo dice. Y como no es 'active', queda fuera de FUENTE_VIGENTE
-- sin tocar ninguna consulta: la vigencia se define por lo que SÍ sirve, no
-- enumerando lo que no.
--
-- El CHECK se reemplaza en vez de agregarse: un CHECK por valor permitido deja
-- la regla en dos lugares. Es una RELAJACIÓN —acepta todo lo que aceptaba antes
-- y uno más—, así que la versión anterior de la app sigue funcionando con este
-- esquema, que es lo que pide la ventana de compatibilidad.
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_status_check;
ALTER TABLE sources ADD CONSTRAINT sources_status_check
  CHECK (status IN ('processing', 'active', 'expired', 'failed', 'delete_failed'));
