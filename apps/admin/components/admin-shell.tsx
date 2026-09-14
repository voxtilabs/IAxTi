'use client';

import { useEffect, useState } from 'react';
import {
  AuditExplorer,
  ModeToggle,
  RequireSession,
  SessionProvider,
  useSession,
  type AuditFetcher,
  type PublicConfig,
} from '@iaxti/ui/react';

interface TenantRow {
  id: string;
  name: string;
  rubro: string | null;
  plan: string;
  state: string;
  createdAt: string;
}

// El color nunca es el único portador: la etiqueta lleva el texto del estado.
const ESTADO_ROL: Record<string, string> = {
  trial: 'bg-action-soft text-action-text border-action-soft-br',
  active: 'bg-good-soft text-good-text border-good-soft-br',
  past_due: 'bg-warn-soft text-warn-text border-warn-soft-br',
  read_only: 'bg-warn-soft text-warn-text border-warn-soft-br',
  suspended: 'bg-bad-soft text-bad-text border-bad-soft-br',
  deleted: 'bg-bad-soft text-bad-text border-bad-soft-br',
};

function CerrarSesion() {
  const { supabase } = useSession();
  return (
    <button
      type="button"
      className="text-sm text-muted"
      onClick={() => void supabase.auth.signOut().then(() => (window.location.href = '/login'))}
    >
      Cerrar sesión
    </button>
  );
}

function TablaTenants() {
  const { session, config } = useSession();
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [sinAcceso, setSinAcceso] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = () => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/tenants`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.status === 403) return setSinAcceso(true);
      if (res.ok) setTenants(await res.json());
    });
  };
  useEffect(cargar, [session, config.apiUrl]); // cargar es estable por render

  const accion = async (path: string, init?: RequestInit) => {
    if (!session) return;
    setAviso(null);
    const res = await fetch(`${config.apiUrl}/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      ...init,
    });
    if (!res.ok) {
      const cuerpo = (await res.json().catch(() => null)) as { message?: string } | null;
      setAviso(cuerpo?.message ?? `Error ${res.status}`);
      return;
    }
    cargar();
  };

  if (sinAcceso) {
    return (
      <p className="rounded-campo border border-warn-soft-br bg-warn-soft px-5 py-4 text-sm text-warn-text">
        <span className="font-medium">Tu cuenta no es de plataforma.</span> Pide acceso a quien
        opera IAxTi.
      </p>
    );
  }
  if (!tenants) return <p className="text-muted">Cargando tenants…</p>;

  return (
    <div>
      {aviso && (
        <p role="alert" className="mb-3 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-2 text-sm text-warn-text">
          {aviso}
        </p>
      )}
    <div className="overflow-x-auto rounded-tarjeta border border-line bg-raised">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-rest text-left">
            {['Negocio', 'Rubro', 'Plan', 'Estado', 'Creado', 'Acciones'].map((h) => (
              <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id} className="border-t border-line">
              <td className="px-4 py-4 font-medium text-ink">{t.name}</td>
              <td className="px-4 py-4 text-body">{t.rubro ?? '—'}</td>
              <td className="px-4 py-4 text-body">{t.plan}</td>
              <td className="px-4 py-4">
                <span className={`rounded-boton border px-3 py-1 text-xs font-medium ${ESTADO_ROL[t.state] ?? 'bg-rest text-muted border-line'}`}>
                  {t.state}
                </span>
              </td>
              <td className="dato px-4 py-4 text-right text-ink">
                {new Date(t.createdAt).toISOString().slice(0, 10)}
              </td>
              <td className="px-4 py-4">
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label={`Plan de ${t.name}`}
                    className="rounded-boton border border-line bg-bg px-2 py-1 text-xs text-body"
                    value={t.plan}
                    onChange={(e) =>
                      void accion(`/platform/tenants/${t.id}/plan`, {
                        body: JSON.stringify({ plan: e.target.value }),
                      })
                    }
                  >
                    {['base', 'crece', 'equipo'].map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  {t.state === 'suspended' || t.state === 'read_only' || t.state === 'past_due' ? (
                    <button
                      type="button"
                      className="rounded-boton border border-good-soft-br bg-good-soft px-2 py-1 text-xs text-good-text"
                      onClick={() =>
                        void accion(`/platform/tenants/${t.id}/state`, {
                          body: JSON.stringify({ action: 'reactivate' }),
                        })
                      }
                    >
                      Reactivar
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded-boton border border-bad-soft-br bg-bad-soft px-2 py-1 text-xs text-bad-text"
                      onClick={() =>
                        void accion(`/platform/tenants/${t.id}/state`, {
                          body: JSON.stringify({ action: 'suspend' }),
                        })
                      }
                    >
                      Suspender
                    </button>
                  )}
                  {t.state === 'trial' && (
                    <button
                      type="button"
                      className="rounded-boton border border-line bg-bg px-2 py-1 text-xs text-body"
                      onClick={() =>
                        void accion(`/platform/tenants/${t.id}/extend-trial`, {
                          body: JSON.stringify({ days: 14 }),
                        })
                      }
                    >
                      +14 días
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-boton border border-warn-soft-br bg-warn-soft px-2 py-1 text-xs text-warn-text"
                    onClick={() =>
                      void accion(`/platform/tenants/${t.id}/support`, {
                        body: JSON.stringify({ hours: 4 }),
                      })
                    }
                  >
                    Soporte 4 h
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}

interface ConsumoRow {
  id: string;
  name: string;
  plan: string;
  used: number;
  limit: number | null;
}

/** El consumo de API por tenant (#26): contra su tope, desde UsageMeter. */
function TablaConsumoApi() {
  const { session, config } = useSession();
  const [filas, setFilas] = useState<ConsumoRow[] | null>(null);

  useEffect(() => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/api-usage`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.ok) setFilas(await res.json());
    });
  }, [session, config.apiUrl]);

  if (!filas) return null;

  return (
    <div className="mt-10">
      <h2 className="mb-4 text-xl font-bold text-ink">Consumo de API (mes en curso)</h2>
      <div className="overflow-x-auto rounded-tarjeta border border-line bg-raised">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest text-left">
              {['Negocio', 'Plan', 'Requests', 'Tope', '% usado'].map((h) => (
                <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((t) => {
              const pct = t.limit ? Math.round((t.used / t.limit) * 100) : null;
              return (
                <tr key={t.id} className="border-t border-line">
                  <td className="px-4 py-4 font-medium text-ink">{t.name}</td>
                  <td className="px-4 py-4 text-body">{t.plan}</td>
                  <td className="dato px-4 py-4 text-right text-ink">{t.used.toLocaleString('es-CL')}</td>
                  <td className="dato px-4 py-4 text-right text-body">
                    {t.limit === null ? '—' : t.limit.toLocaleString('es-CL')}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {pct === null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={`rounded-boton border px-3 py-1 text-xs font-medium ${
                        pct >= 100
                          ? 'bg-bad-soft text-bad-text border-bad-soft-br'
                          : pct >= 80
                            ? 'bg-warn-soft text-warn-text border-warn-soft-br'
                            : 'bg-good-soft text-good-text border-good-soft-br'
                      }`}>
                        {pct} %
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface PlanRow2 {
  plan: string;
  priceClp: number | null;
  iaExecutionsMonth: number;
  retentionMonths: number | null;
  apiRequestsMonth: number | null;
  modules: string[];
}

/** Planes como configuración (#69): editar sin desplegar. */
function TablaPlanes() {
  const { session, config } = useSession();
  const [planes, setPlanes] = useState<PlanRow2[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = () => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/plans`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.ok) setPlanes(await res.json());
    });
  };
  useEffect(cargar, [session, config.apiUrl]);

  const editar = async (plan: string, campo: string, valor: string) => {
    if (!session) return;
    setAviso(null);
    const n = valor === '' ? null : Number(valor);
    const res = await fetch(`${config.apiUrl}/v1/platform/plans/${plan}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ [campo]: n }),
    });
    if (!res.ok) {
      const cuerpo = (await res.json().catch(() => null)) as { message?: string } | null;
      setAviso(cuerpo?.message ?? `Error ${res.status}`);
    }
    cargar();
  };

  if (!planes) return null;
  return (
    <div className="mt-10">
      <h2 className="mb-2 text-xl font-bold text-ink">Planes</h2>
      <p className="mb-4 text-sm text-muted">Configuración, no código: los cambios rigen sin desplegar.</p>
      {aviso && (
        <p role="alert" className="mb-3 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-2 text-sm text-warn-text">{aviso}</p>
      )}
      <div className="overflow-x-auto rounded-tarjeta border border-line bg-raised">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest text-left">
              {['Plan', 'Precio CLP', 'IA/mes', 'Retención (meses)', 'API/mes', 'Módulos'].map((h) => (
                <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {planes.map((p) => (
              <tr key={p.plan} className="border-t border-line">
                <td className="px-4 py-3 font-medium text-ink">{p.plan}</td>
                {(
                  [
                    ['priceClp', p.priceClp],
                    ['iaExecutionsMonth', p.iaExecutionsMonth],
                    ['retentionMonths', p.retentionMonths],
                    ['apiRequestsMonth', p.apiRequestsMonth],
                  ] as const
                ).map(([campo, valor]) => (
                  <td key={campo} className="px-4 py-3">
                    <input
                      aria-label={`${campo} de ${p.plan}`}
                      className="dato w-28 rounded-campo border border-line bg-bg px-2 py-1 text-right text-sm text-ink"
                      defaultValue={valor ?? ''}
                      placeholder="∞"
                      onBlur={(e) => void editar(p.plan, campo, e.target.value)}
                    />
                  </td>
                ))}
                <td className="dato px-4 py-3 text-xs text-muted">{p.modules.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ModuloRow {
  id: string;
  version: string;
  core: boolean;
  active: boolean;
  killSwitch: boolean;
  dependsOn: string[];
  tenantsUsing: number;
}

/** Módulos con kill-switch (#69): el registry valida dependencias. */
function TablaModulos() {
  const { session, config } = useSession();
  const [modulos, setModulos] = useState<ModuloRow[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = () => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/modules`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.ok) setModulos(await res.json());
    });
  };
  useEffect(cargar, [session, config.apiUrl]);

  const accionar = async (id: string, action: string) => {
    if (!session) return;
    setAviso(null);
    const res = await fetch(`${config.apiUrl}/v1/platform/modules/${id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const cuerpo = (await res.json().catch(() => null)) as { message?: string } | null;
      setAviso(cuerpo?.message ?? `Error ${res.status}`);
      return;
    }
    setModulos(await res.json());
  };

  if (!modulos) return null;
  return (
    <div className="mt-10">
      <h2 className="mb-2 text-xl font-bold text-ink">Módulos</h2>
      {aviso && (
        <p role="alert" className="mb-3 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-2 text-sm text-warn-text">{aviso}</p>
      )}
      <div className="overflow-x-auto rounded-tarjeta border border-line bg-raised">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest text-left">
              {['Módulo', 'Versión', 'Estado', 'Depende de', 'Tenants', 'Acciones'].map((h) => (
                <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modulos.map((m) => (
              <tr key={m.id} className="border-t border-line">
                <td className="px-4 py-3 font-medium text-ink">{m.id}{m.core && <span className="rotulo ml-2">núcleo</span>}</td>
                <td className="dato px-4 py-3 text-body">{m.version}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-boton border px-3 py-1 text-xs font-medium ${
                    m.killSwitch
                      ? 'bg-bad-soft text-bad-text border-bad-soft-br'
                      : m.active
                        ? 'bg-good-soft text-good-text border-good-soft-br'
                        : 'bg-rest text-muted border-line'
                  }`}>
                    {m.killSwitch ? 'kill-switch' : m.active ? 'activo' : 'apagado'}
                  </span>
                </td>
                <td className="dato px-4 py-3 text-xs text-muted">{m.dependsOn.join(', ') || '—'}</td>
                <td className="dato px-4 py-3 text-right text-body">{m.tenantsUsing}</td>
                <td className="px-4 py-3">
                  {!m.core && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-boton border border-line bg-bg px-2 py-1 text-xs text-body"
                        onClick={() => void accionar(m.id, m.active ? 'disable' : 'enable')}
                      >
                        {m.active ? 'Apagar' : 'Encender'}
                      </button>
                      <button
                        type="button"
                        className="rounded-boton border border-bad-soft-br bg-bad-soft px-2 py-1 text-xs text-bad-text"
                        onClick={() => void accionar(m.id, m.killSwitch ? 'kill_off' : 'kill_on')}
                      >
                        {m.killSwitch ? 'Soltar kill' : 'Kill-switch'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * El explorador GLOBAL (#72): los mismos componentes que ve el ADMIN de un
 * tenant, con alcance total. La verificación de la cadena es por tenant —
 * la cadena de hash lo es—, así que se pide el tenant en el filtro.
 */
function AuditGlobal() {
  const { session, config } = useSession();
  if (!session) return null;
  const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();
  const llamar = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${config.apiUrl}/v1${path}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      ...init,
    });
    if (!res.ok) {
      const cuerpo = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(cuerpo?.message ?? `No pudimos consultar el libro (HTTP ${res.status}).`);
    }
    return res.json();
  };
  const fetcher: AuditFetcher = {
    global: true,
    search: (p) => llamar(`/platform/audit?${qs(p)}`),
    verify: (tenantId) =>
      llamar(`/platform/audit/verify?tenantId=${tenantId ?? ''}`, { method: 'POST', body: '{}' }),
    exportar: (format, p) => llamar(`/platform/audit/export?${qs({ ...p, format })}`),
  };
  return (
    <div className="mt-10">
      <h2 className="mb-1 text-xl font-bold text-ink">Auditoría</h2>
      <p className="mb-4 text-sm text-muted">
        El libro de todos los tenants. Para verificar la cadena, pon el tenant en el filtro: la
        cadena de hash es por tenant.
      </p>
      <AuditExplorer fetcher={fetcher} />
    </div>
  );
}

interface ChequeoDto {
  id: string;
  titulo: string;
  estado: 'bien' | 'atencion' | 'mal' | 'sin_fuente';
  detalle: string;
  valor?: number | string | null;
  umbral?: string;
}

const ESTADO_CHEQUEO: Record<ChequeoDto['estado'], { label: string; clase: string }> = {
  bien: { label: 'Bien', clase: 'border-good-soft-br bg-good-soft text-good-text' },
  atencion: { label: 'Atención', clase: 'border-warn-soft-br bg-warn-soft text-warn-text' },
  mal: { label: 'Mal', clase: 'border-bad-soft-br bg-bad-soft text-bad-text' },
  sin_fuente: { label: 'Sin fuente', clase: 'border-line bg-rest text-muted' },
};

function Chequeos({ chequeos }: { chequeos: ChequeoDto[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {chequeos.map((c) => (
        <li key={c.id} className={`rounded-tarjeta border px-3 py-2 ${ESTADO_CHEQUEO[c.estado].clase}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{c.titulo}</span>
            {/* El color nunca es el único portador: el estado va escrito. */}
            <span className="rotulo">{ESTADO_CHEQUEO[c.estado].label}</span>
          </div>
          <p className="mt-1 text-sm">{c.detalle}</p>
          {c.umbral && <p className="dato mt-1 text-xs opacity-70">Umbral: {c.umbral}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Seguridad y salud en un solo lugar (#71): qué está mal y dónde. */
function SeguridadYSalud() {
  const { session, config } = useSession();
  const [salud, setSalud] = useState<{ estado: string; chequeos: ChequeoDto[] } | null>(null);
  const [seguridad, setSeguridad] = useState<{
    estado: string;
    desde: string;
    chequeos: ChequeoDto[];
    permisosDenegados: Array<{ tenant_id: string; actor: string; ip: string | null; n: number }>;
    numerosEnRiesgo: Array<{ tenant_id: string; display_phone: string | null; quality: string | null }>;
  } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const traer = async (path: string) => {
      const res = await fetch(`${config.apiUrl}/v1${path}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`No pudimos consultar ${path} (HTTP ${res.status}).`);
      return res.json();
    };
    void Promise.all([traer('/platform/health'), traer('/platform/security')])
      .then(([h, s]) => {
        setSalud(h);
        setSeguridad(s);
      })
      .catch((err: Error) => setAviso(err.message));
  }, [session, config.apiUrl]);

  return (
    <div className="mt-10">
      <h2 className="mb-1 text-xl font-bold text-ink">Seguridad y salud</h2>
      <p className="mb-4 text-sm text-muted">
        Todo sale de fuentes reales: el libro de auditoría, la base, Redis y el registro de módulos.
        Lo que no tiene fuente conectada lo dice, en vez de mostrar un cero tranquilizador.
      </p>
      {aviso && (
        <p role="alert" className="mb-3 rounded-campo border border-warn-soft-br bg-warn-soft px-3 py-2 text-sm text-warn-text">
          {aviso}
        </p>
      )}
      {salud && (
        <>
          <p className="rotulo mb-2">Salud de las dependencias</p>
          <Chequeos chequeos={salud.chequeos} />
        </>
      )}
      {seguridad && (
        <>
          <p className="rotulo mb-2 mt-6">
            Seguridad · desde {new Date(seguridad.desde).toLocaleDateString('es-CL')}
          </p>
          <Chequeos chequeos={seguridad.chequeos} />
          {seguridad.permisosDenegados.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-tarjeta border border-line bg-raised">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-rest text-left">
                    {['Tenant', 'Actor', 'IP', 'Intentos'].map((h) => (
                      <th key={h} className="rotulo px-3 py-2 font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {seguridad.permisosDenegados.map((d, i) => (
                    <tr key={`${d.actor}-${i}`} className="border-b border-line last:border-0">
                      <td className="dato px-3 py-2 text-xs text-faint">{d.tenant_id.slice(0, 8)}</td>
                      <td className="dato px-3 py-2 text-xs text-body">{d.actor.slice(0, 13)}</td>
                      <td className="dato px-3 py-2 text-xs text-muted">{d.ip ?? '—'}</td>
                      <td className="dato px-3 py-2 text-xs text-ink">{d.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}


interface FilaIADto {
  clave: string;
  ejecuciones: number;
  fallidas: number;
  costUsd: number;
  costClp: number;
  latenciaP50: number | null;
  latenciaP95: number | null;
  exitoPct: number;
}

interface AlertaIADto {
  tenantId: string;
  nombre: string;
  plan: string;
  costClpCiclo: number;
  presupuestoUsd: number | null;
  pct: number | null;
  nivel: 'ok' | 'atencion' | 'excedido';
}

interface EjecucionIADto {
  id: string;
  tenantId: string;
  task: string;
  provider: string;
  model: string;
  status: string;
  costUsd: number;
  latencyMs: number | null;
  traceId: string | null;
  traceUrl: string | null;
  conversationId: string | null;
  createdAt: string;
}

const AGRUPACIONES = [
  { id: 'dia', label: 'Por día' },
  { id: 'modelo', label: 'Por modelo' },
  { id: 'tenant', label: 'Por tenant' },
  { id: 'tarea', label: 'Por tarea' },
] as const;

const clp = (n: number) => `$${n.toLocaleString('es-CL')}`;

/** Centro de IA (#70): si el modelo barato conviene, se ve acá. */
function CentroIA() {
  const { session, config } = useSession();
  const [groupBy, setGroupBy] = useState<string>('modelo');
  const [datos, setDatos] = useState<{ filas: FilaIADto[]; alertas: AlertaIADto[]; usdClp: number } | null>(null);
  const [ejecuciones, setEjecuciones] = useState<EjecucionIADto[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const traer = async (path: string) => {
      const res = await fetch(`${config.apiUrl}/v1${path}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`No pudimos consultar ${path} (HTTP ${res.status}).`);
      return res.json();
    };
    void Promise.all([traer(`/platform/ia?groupBy=${groupBy}`), traer('/platform/ia/ejecuciones')])
      .then(([m, e]) => {
        setDatos(m);
        setEjecuciones(e);
      })
      .catch((err: Error) => setAviso(err.message));
  }, [session, config.apiUrl, groupBy]);

  return (
    <div className="mt-10">
      <h2 className="mb-1 text-xl font-bold text-ink">Centro de IA</h2>
      <p className="mb-4 text-sm text-muted">
        Costo, éxito y latencia por modelo. El p95 importa más que el promedio: un agente que se
        cuelga una de cada veinte veces se ve normal en la media y pésimo en la práctica.
      </p>
      {aviso && (
        <p role="alert" className="mb-3 rounded-campo border border-warn-soft-br bg-warn-soft px-3 py-2 text-sm text-warn-text">
          {aviso}
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        {AGRUPACIONES.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setGroupBy(g.id)}
            className={`rounded-boton border px-3 py-1.5 text-sm ${
              groupBy === g.id ? 'border-action bg-action text-action-contrast' : 'border-line bg-bg text-body'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {datos && (
        <div className="overflow-x-auto rounded-tarjeta border border-line bg-raised">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-rest text-left">
                {['Clave', 'Ejecuciones', 'Éxito', 'p50', 'p95', 'Costo'].map((h) => (
                  <th key={h} className="rotulo px-3 py-2 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datos.filas.map((f) => (
                <tr key={f.clave} className="border-b border-line last:border-0">
                  <td className="dato px-3 py-2 text-xs text-ink">{f.clave}</td>
                  <td className="dato px-3 py-2 text-xs text-body">
                    {f.ejecuciones}
                    {f.fallidas > 0 && <span className="text-bad-text"> · {f.fallidas} fallidas</span>}
                  </td>
                  <td className="dato px-3 py-2 text-xs text-body">{f.exitoPct}%</td>
                  <td className="dato px-3 py-2 text-xs text-muted">{f.latenciaP50 ?? '—'} ms</td>
                  <td className="dato px-3 py-2 text-xs text-muted">{f.latenciaP95 ?? '—'} ms</td>
                  <td className="dato px-3 py-2 text-xs text-ink">{clp(f.costClp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {datos.filas.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted">Todavía no hay ejecuciones en la ventana.</p>
          )}
        </div>
      )}

      {datos && datos.alertas.some((a) => a.nivel !== 'ok') && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {datos.alertas
            .filter((a) => a.nivel !== 'ok')
            .map((a) => (
              <li
                key={a.tenantId}
                className={`rounded-tarjeta border px-3 py-2 text-sm ${
                  a.nivel === 'excedido'
                    ? 'border-bad-soft-br bg-bad-soft text-bad-text'
                    : 'border-warn-soft-br bg-warn-soft text-warn-text'
                }`}
              >
                <span className="font-medium">{a.nombre}</span> · plan {a.plan}
                <p className="mt-1">
                  {clp(a.costClpCiclo)} este ciclo
                  {a.pct !== null && ` · ${a.pct}% del presupuesto`}
                  {a.nivel === 'excedido' ? ' — se pasó.' : ' — va a pasarse.'}
                </p>
              </li>
            ))}
        </ul>
      )}

      {ejecuciones.length > 0 && (
        <>
          <p className="rotulo mb-2 mt-6">Últimas ejecuciones</p>
          <div className="overflow-x-auto rounded-tarjeta border border-line bg-raised">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-rest text-left">
                  {['Cuándo', 'Tenant', 'Tarea', 'Modelo', 'Latencia', 'Estado', 'Trace'].map((h) => (
                    <th key={h} className="rotulo px-3 py-2 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ejecuciones.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="dato px-3 py-2 text-xs text-muted">
                      {new Date(e.createdAt).toLocaleString('es-CL')}
                    </td>
                    <td className="dato px-3 py-2 text-xs text-faint">{e.tenantId.slice(0, 8)}</td>
                    <td className="dato px-3 py-2 text-xs text-body">{e.task}</td>
                    <td className="dato px-3 py-2 text-xs text-ink">{e.provider}/{e.model}</td>
                    <td className="dato px-3 py-2 text-xs text-muted">{e.latencyMs ?? '—'} ms</td>
                    <td className="px-3 py-2 text-xs">
                      {e.status === 'ok' ? (
                        <span className="text-good-text">ok</span>
                      ) : (
                        <span className="text-bad-text">falló</span>
                      )}
                    </td>
                    <td className="dato px-3 py-2 text-xs">
                      {/* Sin Langfuse configurado queda el id, que igual sirve para buscar. */}
                      {e.traceUrl ? (
                        <a className="text-action underline" href={e.traceUrl} target="_blank" rel="noreferrer">
                          ver trace
                        </a>
                      ) : (
                        <span className="text-muted">{e.traceId ?? '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function AdminShell({ config, marcaSvg }: { config: PublicConfig; marcaSvg: string }) {
  return (
    <SessionProvider config={config}>
      <RequireSession>
        <div className="min-h-screen bg-bg">
          <header className="border-b border-line bg-raised">
            <div className="mx-auto flex max-w-contenido flex-wrap items-center gap-4 px-4 py-3">
              <a href="/" className="marca" aria-label="VoxTi Labs, panel de IAxTi"
                 dangerouslySetInnerHTML={{ __html: marcaSvg }} />
              <span className="rotulo">SuperAdmin</span>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <ModeToggle />
                <CerrarSesion />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-contenido px-4 py-8">
            <h2 className="mb-4 text-xl font-bold text-ink">Tenants</h2>
            <TablaTenants />
            <TablaPlanes />
            <TablaModulos />
            <TablaConsumoApi />
            <AuditGlobal />
            <CentroIA />
            <SeguridadYSalud />
          </main>
        </div>
      </RequireSession>
    </SessionProvider>
  );
}
