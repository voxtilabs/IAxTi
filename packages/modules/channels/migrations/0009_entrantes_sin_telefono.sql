-- Un mensaje que llega sin teléfono deja rastro y se cuenta (#1331).
--
-- WhatsApp está pasando a identificar a algunas personas con un id propio del
-- negocio (BSUID) y sin número, y en el webhook de Zernio `sender.phoneNumber`
-- puede venir nulo. IAxTi identifica al contacto por teléfono, así que ese
-- mensaje no tiene cómo entrar todavía: lo que no puede pasar es que se pierda
-- sin que nadie lo sepa. Se cuenta por cuenta, con la hora del último, para
-- medir si pasa antes de decidir cómo recibirlos.
--
-- Aditiva: dos columnas con valor por defecto; la versión anterior de la
-- aplicación no las lee ni las escribe.
ALTER TABLE channel_accounts
  ADD COLUMN IF NOT EXISTS inbound_sin_telefono integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inbound_sin_telefono_at timestamptz;
