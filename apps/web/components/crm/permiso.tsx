import { Badge } from '@iaxti/ui/react';

/** El permiso calculado por la API con la regla del envío (#1346). */
export type PermisoValor = 'baja' | 'opt_in' | 'escribio_primero' | 'sin_permiso' | undefined;

/**
 * Si se le puede escribir primero, y por qué (#1346). El texto lleva el
 * significado; el color acompaña. «Se dio de baja» va en texto apagado porque
 * el nombre ya trae el «No contactar» en rojo —que es lo que se ve en el
 * celular, donde esta columna no está— y dos rojos para lo mismo gritan.
 */
export function Permiso({ valor }: { valor: PermisoValor }) {
  if (valor === 'opt_in') return <Badge role="good">Dio permiso</Badge>;
  if (valor === 'escribio_primero') return <Badge role="good">Escribió primero</Badge>;
  if (valor === 'baja') return <span className="text-muted">Se dio de baja</span>;
  if (valor === 'sin_permiso') return <span className="text-muted">Sin permiso</span>;
  return <span className="text-muted">—</span>;
}
