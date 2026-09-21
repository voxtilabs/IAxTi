interface Dependency {
  nombre: string;
  ok: boolean;
  ms: number;
  detalle?: string;
}

/** Sonda de dependencias; no copia cuerpos, URLs ni errores del proveedor. */
export async function frontendReadiness(
  service: 'web' | 'admin',
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 2_000,
): Promise<Response> {
  async function probe(
    nombre: string,
    base: string | undefined,
    path: string,
    valid: (body: Record<string, unknown>) => boolean,
    key?: string,
  ): Promise<Dependency> {
    const started = Date.now();
    if (!base?.trim() || (nombre === 'supabase_auth' && !key?.trim())) {
      return { nombre, ok: false, ms: 0, detalle: 'sin configurar' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(`${base.replace(/\/+$/, '')}${path}`);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Protocolo inválido.');
      // Next respeta cache; los tipos de fetch de Node no incluyen esa extensión.
      const options = {
        signal: controller.signal, redirect: 'error' as const, cache: 'no-store' as const,
        ...(key ? { headers: { apikey: key } } : {}),
      };
      const response = await fetch(url, options);
      if (!response.ok) {
        return { nombre, ok: false, ms: Date.now() - started, detalle: `respuesta HTTP ${response.status}` };
      }
      const body: unknown = await response.json();
      const ok = body !== null && typeof body === 'object' && valid(body as Record<string, unknown>);
      return { nombre, ok, ms: Date.now() - started, ...(!ok ? { detalle: 'respuesta no lista' } : {}) };
    } catch {
      return { nombre, ok: false, ms: Date.now() - started,
        detalle: controller.signal.aborted ? 'no respondió a tiempo' : 'no disponible',
      };
    } finally { clearTimeout(timer); }
  }
  const dependencias = await Promise.all([
    probe('api', env.API_URL_INTERNAL ?? env.API_URL_PUBLIC, '/ready', body => body.status === 'ok'),
    probe('supabase_auth', env.SUPABASE_URL, '/auth/v1/health', body => body.name === 'GoTrue', env.SUPABASE_ANON_KEY),
  ]);
  const ok = dependencias.every(d => d.ok);
  return Response.json({ status: ok ? 'ok' : 'degraded', service, dependencias }, {
    status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' },
  });
}
