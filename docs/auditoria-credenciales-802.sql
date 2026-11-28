-- Auditoría de credenciales pegadas (#802): correr en producción y en
-- staging con el rol de aplicación. Devuelve CONTEOS, nunca valores —
-- si una fila sale, se rota el mismo día (SECURITY_BASELINE) y el
-- resultado NO se pega en ningún chat.
--
-- Nota (#1393, ADR-0038): las referencias `cu:custodia-local/...` SON la
-- forma correcta desde el 26-11; este query las cuenta aparte para que no
-- aparezcan como sospechosas. `sm:` es la forma histórica del secreto del
-- webhook (#1175) y también es válida.

SELECT 'channel_accounts' AS tabla,
       count(*) FILTER (WHERE (credential_ref IS NOT NULL AND credential_ref !~ '^[A-Z][A-Z0-9_]{0,63}$' AND credential_ref NOT LIKE 'cu:%' AND credential_ref NOT LIKE 'sm:%')
                     OR (webhook_secret_ref IS NOT NULL AND webhook_secret_ref !~ '^[A-Z][A-Z0-9_]{0,63}$' AND webhook_secret_ref NOT LIKE 'cu:%' AND webhook_secret_ref NOT LIKE 'sm:%')) AS sospechosas,
       count(*) FILTER (WHERE credential_ref LIKE 'cu:%' OR webhook_secret_ref LIKE 'cu:%') AS custodia
  FROM channel_accounts
UNION ALL
SELECT 'payment_providers',
       count(*) FILTER (WHERE (credential_ref IS NOT NULL AND credential_ref !~ '^[A-Z][A-Z0-9_]{0,63}$')
                          OR (webhook_secret_ref IS NOT NULL AND webhook_secret_ref !~ '^[A-Z][A-Z0-9_]{0,63}$')),
       0
  FROM payment_providers;
