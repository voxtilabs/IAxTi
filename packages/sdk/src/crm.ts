import { crmRoutes } from './crm-routes.generated';

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
    deals: <T>(query: URLSearchParams) => request<{ items: T[]; nextCursor: string | null }>('DealsController_list', query),
    tags: () => request<Array<{ id: string; name: string }>>('TagsController_list'),
    tag: (contactIds: string[], tagId: string) => request<{ requested: number; changed: number }>('TagsController_agregarEnLote', undefined, { contactIds, tagId }),
  };
}
