-- De quién es un emisor del proveedor (#771).
--
-- Todos los tenants comparten una llave de proyecto de Zavu (`ZAVU_API_KEY`),
-- así que ese proyecto contiene los emisores de TODOS los negocios. La ruta que
-- los lista —y la que los acepta para reapuntar un canal (#600)— no tenían forma
-- de saber de quién es cada uno: `elegirSender` solo mira si el emisor tiene el
-- canal encendido.
--
-- Resultado medido: el tenant A veía «snd_xxx · Ferretería El Sol», y podía
-- apuntar su canal a un emisor que otro negocio todavía no conectó o que archivó
-- — y quedar despachando WhatsApp desde el número de un tercero.
--
-- El aislamiento lo estaba sosteniendo, por accidente, el único global
-- `whatsapp_numbers_sender_idx`: chocaba SOLO cuando el emisor estaba activo en
-- otro tenant, y sin que nadie atrapara el 23505.
--
-- ## Por qué SECURITY DEFINER
--
-- La pregunta cruza tenants por definición: «¿este emisor es de alguien más?».
-- `whatsapp_numbers` tiene RLS, así que desde el contexto del tenant A la fila
-- de B no se ve — y no verla es exactamente lo que produce el agujero.
--
-- Devuelve SOLO el `tenant_id` y nada más: ni el nombre del negocio, ni el
-- teléfono, ni cuándo se conectó. Quien pregunta solo necesita saber si es suyo
-- o de otro, y cualquier cosa de más sería la misma fuga por otra puerta
-- (ADR-0026).
--
-- Cuenta los ARCHIVADOS también: un número que un negocio dio de baja sigue
-- siendo su número. Que su índice único ya no lo proteja es justamente el hueco
-- que esto tapa.
CREATE OR REPLACE FUNCTION tenant_del_emisor(p_sender_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM whatsapp_numbers
   WHERE sender_id = p_sender_id
   ORDER BY disconnected_at NULLS FIRST, created_at
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION tenant_del_emisor(text) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenant_del_emisor(text) TO iaxti_app;
  END IF;
END $$;
