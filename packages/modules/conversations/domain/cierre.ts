// Cierre automático y archivo (#40, SPEC §39). Puro.

export interface CierreSettings {
  /** Días sin actividad para pasar open/pending a resolved. Mínimo 1. */
  autoResolveDays: number;
  /** Meses para archivar una resuelta. null = desactivado. */
  archiveAfterMonths: number | null;
}

/** Lee las claves de §39 tal cual (`auto_resolve_days`, `archive_after_months`). */
export function cierreSettings(settings: Record<string, unknown> | null | undefined): CierreSettings {
  const dias = settings?.auto_resolve_days;
  const meses = settings?.archive_after_months;
  return {
    autoResolveDays:
      typeof dias === 'number' && Number.isFinite(dias) && dias >= 1 ? Math.floor(dias) : 7,
    archiveAfterMonths:
      meses === null
        ? null
        : typeof meses === 'number' && Number.isFinite(meses) && meses >= 1
          ? Math.floor(meses)
          : 3,
  };
}
