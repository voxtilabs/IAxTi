-- #65: Gmail comparte el consentimiento incremental y la custodia de Identity.
ALTER TABLE google_oauth_attempts DROP CONSTRAINT google_oauth_attempts_service_check;
ALTER TABLE google_oauth_attempts ADD CONSTRAINT google_oauth_attempts_service_check CHECK(service IN ('calendar','drive','gmail'));
ALTER TABLE google_oauth_grants DROP CONSTRAINT google_oauth_grants_services_check;
ALTER TABLE google_oauth_grants ADD CONSTRAINT google_oauth_grants_services_check CHECK(cardinality(services)>0 AND services <@ ARRAY['calendar','drive','gmail']::text[]);
