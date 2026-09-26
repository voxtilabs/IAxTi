-- #526: el `senderId` que el adaptador necesita PARA ENVIAR no quedó en el
-- lugar donde lo lee.
--
-- ADR-0014 movió el identificador operativo a `sender_id` y la migración 0003
-- agregó esa columna a `whatsapp_numbers`. Lo que no hizo fue tocar el
-- `config` de `channel_accounts`, que es de donde lo lee el adaptador de
-- Zavu:
--
--   const senderId = account.config.senderId as string | undefined;
--   if (!senderId) throw new Error('La cuenta de canal no tiene senderId.');
--
-- Así que una cuenta conectada ANTES de 0003 recibe mensajes sin problema —el
-- entrante se resuelve por el id de la cuenta en el webhook— y falla TODOS los
-- envíos. El negocio ve llegar los mensajes de sus clientes y no puede
-- contestar ninguno.
--
-- Se rellena desde `whatsapp_numbers.sender_id`, y si esa también está vacía,
-- desde `phone_number_id`: antes de ADR-0014 el id del número de Meta ERA el
-- identificador operativo, así que es el valor correcto para una cuenta de esa
-- época y no una adivinanza.
UPDATE channel_accounts ca
   SET config = ca.config || jsonb_build_object('senderId', n.sender_id)
  FROM whatsapp_numbers n
 WHERE n.channel_account_id = ca.id
   AND n.tenant_id = ca.tenant_id
   AND n.sender_id IS NOT NULL
   AND COALESCE(ca.config ->> 'senderId', '') = '';

UPDATE channel_accounts ca
   SET config = ca.config || jsonb_build_object('senderId', n.phone_number_id)
  FROM whatsapp_numbers n
 WHERE n.channel_account_id = ca.id
   AND n.tenant_id = ca.tenant_id
   AND n.sender_id IS NULL
   AND n.phone_number_id IS NOT NULL
   AND COALESCE(ca.config ->> 'senderId', '') = '';

-- Y la columna queda coherente con el config: una fila con sender_id NULL es
-- la forma vieja, y el producto ya no la puede crear (`connectWhatsAppNumber`
-- exige `senderId` desde ADR-0014). Dejarla NULL hace que el diagnóstico y el
-- envío discrepen sobre la misma cuenta.
UPDATE whatsapp_numbers
   SET sender_id = phone_number_id
 WHERE sender_id IS NULL AND phone_number_id IS NOT NULL;
