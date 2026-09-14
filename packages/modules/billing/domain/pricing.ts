// Los precios (#67, SPEC §20): defaults del negocio con override por env
// (BILLING_PRICES_JSON) — cambiar precios no es un deploy. Tres costos
// SEPARADOS: plan, exceso de Meta y ampliación de IA.

export interface PlanPricing {
  /** Cargo fijo mensual del plan, en CLP. */
  monthlyClp: number;
  /** Costo de Meta INCLUIDO en el plan, en USD del ciclo. */
  metaIncludedUsd: number;
}

const DEFAULTS: Record<string, PlanPricing> = {
  base: { monthlyClp: 29990, metaIncludedUsd: 10 },
  crece: { monthlyClp: 59990, metaIncludedUsd: 25 },
  equipo: { monthlyClp: 99990, metaIncludedUsd: 60 },
};

export function planPricing(plan: string): PlanPricing {
  try {
    const override = process.env.BILLING_PRICES_JSON
      ? (JSON.parse(process.env.BILLING_PRICES_JSON) as Record<string, PlanPricing>)
      : {};
    return override[plan] ?? DEFAULTS[plan] ?? DEFAULTS.base;
  } catch {
    return DEFAULTS[plan] ?? DEFAULTS.base;
  }
}

/** Tipo de cambio para facturar el exceso de Meta (override por env). */
export function usdClpRate(): number {
  const n = Number(process.env.BILLING_USD_CLP ?? process.env.USD_CLP_RATE);
  return Number.isFinite(n) && n > 0 ? n : 950;
}

export interface InvoiceLine {
  concepto: 'plan' | 'exceso_meta' | 'ampliacion_ia';
  detalle: string;
  amountClp: number;
}

/**
 * Las líneas de la factura del ciclo. El exceso de Meta sale de lo
 * consumido sobre lo incluido; la ampliación de IA es un cargo fijo
 * contratado (settings.billing.iaAmpliacionClp) — nada se inventa.
 */
export function buildInvoiceLines(input: {
  plan: string;
  metaSpentUsd: number;
  iaAmpliacionClp?: number | null;
}): InvoiceLine[] {
  const pricing = planPricing(input.plan);
  const lines: InvoiceLine[] = [
    {
      concepto: 'plan',
      detalle: `Plan ${input.plan} — cargo mensual`,
      amountClp: pricing.monthlyClp,
    },
  ];
  const excesoUsd = Math.max(0, input.metaSpentUsd - pricing.metaIncludedUsd);
  if (excesoUsd > 0) {
    lines.push({
      concepto: 'exceso_meta',
      detalle: `WhatsApp sobre lo incluido: USD ${excesoUsd.toFixed(2)} (incluye USD ${pricing.metaIncludedUsd})`,
      amountClp: Math.round(excesoUsd * usdClpRate()),
    });
  }
  if (input.iaAmpliacionClp && input.iaAmpliacionClp > 0) {
    lines.push({
      concepto: 'ampliacion_ia',
      detalle: 'Ampliación de asistencias de IA contratada',
      amountClp: Math.round(input.iaAmpliacionClp),
    });
  }
  return lines;
}

export function invoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((a, l) => a + l.amountClp, 0);
}
