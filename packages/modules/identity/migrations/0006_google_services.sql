-- #64: un consentimiento personal y una referencia de custodia compartidos.
-- Los servicios se acreditan solo con los scopes efectivos devueltos por Google.
ALTER TABLE google_oauth_attempts DROP CONSTRAINT google_oauth_attempts_service_check;
ALTER TABLE google_oauth_attempts ADD CONSTRAINT google_oauth_attempts_service_check
  CHECK (service IN ('calendar','drive'));
ALTER TABLE google_oauth_grants ADD COLUMN services text[] NOT NULL DEFAULT ARRAY['calendar']::text[];
ALTER TABLE google_oauth_grants ADD CONSTRAINT google_oauth_grants_services_check
  CHECK (cardinality(services)>0 AND services <@ ARRAY['calendar','drive']::text[]);
