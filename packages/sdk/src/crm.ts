import { crmRoutes } from './crm-routes.generated';

/**
 * El contacto agregado a mano (#1395), en la misma forma en que lo devuelve la
 * ficha (`GET /contacts/:id`, su campo `contact`): crear no exige volver a
 * pedir nada para mostrar lo que quedó guardado.
 *
 * Nace con `origin: 'manual'` y sin permiso para escribirle: hasta que la
 * persona escriba o dé su opt-in, no se le puede iniciar una conversación.
 */
export interface ContactoCreado {
  id: string;
  phone: string | null;
  name: string | null;
  email: string | null;
  rut: string | null;
  origin: string;
  owner_id: string | null;
  custom: Record<string, unknown>;
  opt_in_at: string | null;
  opt_in_channel: string | null;
  opt_in_evidence: string | null;
  opted_out_at: string | null;
  last_activity_at: string;
  created_at: string;
  company_id: string | null;
  company_name: string | null;
}

export function crmClient(config: { apiUrl: string; token: string; tenantId: string }) {
  async function request<T>(operation: keyof typeof crmRoutes, query?: URLSearchParams, body?: unknown): Promise<T> {
    const route = crmRoutes[operation];
    const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${route.path}${query ? `?${query}` : ''}`, {
      method: route.method,
      headers: { Authorization: `Bearer ${config.token}`, 'X-Tenant-Id': config.tenantId,
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.message ?? 'No pudimos actualizar la lista. Intenta de nuevo.');
    }
    return response.json() as Promise<T>;
  }
  return {
    contacts: <T>(query: URLSearchParams) => request<{ items: T[]; nextCursor: string | null }>('ContactsController_list', query),
    createContact: (body: { phone: string; name?: string; email?: string }) =>
      request<ContactoCreado>('ContactsController_create', undefined, body),
    deals: <T>(query: URLSearchParams) => request<{ items: T[]; nextCursor: string | null }>('DealsController_list', query),
    tags: () => request<Array<{ id: string; name: string }>>('TagsController_list'),
    tag: (contactIds: string[], tagId: string) => request<{ requested: number; changed: number }>('TagsController_agregarEnLote', undefined, { contactIds, tagId }),
  };
}
