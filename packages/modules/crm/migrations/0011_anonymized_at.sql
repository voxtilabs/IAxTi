-- #64: barrera explícita para que consumidores opcionales de datos personales
-- no revivan referencias/copias mientras el outbox procesa la supresión.
ALTER TABLE contacts ADD COLUMN anonymized_at timestamptz;
