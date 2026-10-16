-- Antes de crear un recurso externo queda una intención durable. Un timeout
-- de create/addVersion no puede dejar un secreto imposible de localizar.
ALTER TABLE google_secret_versions ADD COLUMN whole_secret boolean NOT NULL DEFAULT false;
