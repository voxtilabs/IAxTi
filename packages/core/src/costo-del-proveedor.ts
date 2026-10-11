/**
 * Cuánto cobró el proveedor por un mensaje, si lo dice.
 *
 * ## Por qué vive en core
 *
 * Porque tres módulos preguntan lo mismo: `conversations` guarda el costo,
 * `analytics` lo acumula en `costo_meta_usd` y `automations` lo suma por
 * campaña. Vivía en el dominio de `analytics` y sin salida por el contrato,
 * así que el tercero no podía usarlo: `automations` escribió su propia
 * versión —`SUM((meta->'costo'->>'amount')::numeric)`, una sola llave, sin
 * mirar la moneda— y todas las campañas informaban US$0,00 (#795).
 *
 * Es la misma razón por la que `diaEn` está acá y no en analytics: una
 * definición que dos módulos necesitan, en dos copias, son dos definiciones.
 *
 * ## Qué sabe
 *
 * El costo se guarda TAL CUAL lo manda el proveedor (`messages.meta.costo`),
 * que es un objeto `{ amount, currency, category, … }` cuya forma no
 * controlamos. La agregación original hacía `Number(meta->>'costo')` sobre
 * ese objeto —o sea `Number('{"amount":…}')`, que es NaN— y por eso
 * `costo_meta_usd` no se incrementaba nunca.
 *
 * No es solo una pantalla en cero: el excedente de Meta sobre el tope del
 * plan se factura sumando esa métrica. Con la métrica en cero, el exceso lo
 * pagábamos nosotros.
 *
 * Acepta también un número pelado, por si un proveedor manda solo el monto.
 * Si no hay monto reconocible devuelve **null**, no cero: preferimos no
 * contar nada antes que inventar una cifra que después se le cobra a alguien.
 * La diferencia importa aguas arriba — «el proveedor no informó» y «salió
 * gratis» se muestran distinto.
 *
 * Hoy, con lo que manda Meta en el webhook de estados —`{ billable: true,
 * pricing_model: 'CBP', category: 'service' }`— devuelve null, y eso es
 * correcto: ahí NO viene el monto.
 */
const LLAVES_DE_MONTO = ['amount', 'amountUsd', 'total', 'totalUsd', 'costUsd', 'value'];

export function montoDelCosto(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) && valor > 0 ? valor : null;
  if (!valor || typeof valor !== 'object') return null;
  const obj = valor as Record<string, unknown>;

  // Una moneda declarada y distinta de USD no se suma a un total en USD.
  const moneda = obj.currency ?? obj.moneda;
  if (typeof moneda === 'string' && moneda.toUpperCase() !== 'USD') return null;

  for (const llave of LLAVES_DE_MONTO) {
    const n = Number(obj[llave]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
