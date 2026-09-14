-- billing (#67, SPEC §20): la suscripción del tenant y sus facturas con
-- las líneas SEPARADAS — nada de totales mágicos.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL UNIQUE REFERENCES tenants(id),
  plan               text NOT NULL,
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','past_due','cancelled')),
  cycle_start        date NOT NULL DEFAULT date_trunc('month', now())::date,
  next_charge_at     date NOT NULL,
  -- Referencia al medio de pago EN el proveedor — jamás datos de tarjeta.
  payment_method_ref text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscriptions') THEN
    CREATE POLICY tenant_isolation ON subscriptions
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  subscription_id uuid REFERENCES subscriptions(id),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  -- [{concepto, detalle, amountClp}] — plan, exceso Meta, ampliación IA.
  lines           jsonb NOT NULL,
  total_clp       numeric(14,0) NOT NULL,
  status          text NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','paid','overdue','void')),
  payment_link_id uuid,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  due_at          timestamptz NOT NULL,
  paid_at         timestamptz,
  -- Una factura por tenant y período: el job mensual es idempotente.
  UNIQUE (tenant_id, period_start)
);
CREATE INDEX IF NOT EXISTS invoices_tenant_idx ON invoices (tenant_id, issued_at DESC);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invoices') THEN
    CREATE POLICY tenant_isolation ON invoices
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
