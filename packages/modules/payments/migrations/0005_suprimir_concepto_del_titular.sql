-- #903: la supresión debe vaciar el concepto también en un cobro pagado.
-- El texto vacío mantiene NOT NULL y el contrato público `concept: string`.
-- Se conserva la inmutabilidad financiera: solo se admite vaciar ese campo,
-- sin cambiar ninguna otra columna; un DELETE de un pagado sigue prohibido.
CREATE OR REPLACE FUNCTION payment_links_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'paid' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.concept = '' AND OLD.concept <> ''
         AND (to_jsonb(NEW) - 'concept') = (to_jsonb(OLD) - 'concept') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Un link pagado es inmutable.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
