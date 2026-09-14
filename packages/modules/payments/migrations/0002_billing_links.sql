-- billing (#67) cobra al TENANT, no a un contacto: el link puede nacer
-- sin contact_id.
ALTER TABLE payment_links ALTER COLUMN contact_id DROP NOT NULL;
