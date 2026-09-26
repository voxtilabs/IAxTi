'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  AuditExplorer,
  MarcaJelly,
  ModeToggle,
  RequireSession,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SessionProvider,
  useSession,
  useMarcaSvg,
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
  const [nombreNuevo, setNombreNuevo] = useState('');
  const [rubroNuevo, setRubroNuevo] = useState('');

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
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
      {/* Crear un negocio a mano (#480). `POST /platform/tenants` existía
          desde #69 y no la llamaba nadie: un cliente que se cierra por
          teléfono había que meterlo por la API, y el que opera IAxTi no
          tiene por qué entrar a la base para eso. Nace en prueba, como lo
          crea el servidor. */}
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nombreNuevo.trim()) return;
          void accion('/platform/tenants', {
            body: JSON.stringify({ name: nombreNuevo.trim(), rubro: rubroNuevo.trim() || undefined }),
          }).then(() => {
            setNombreNuevo('');
            setRubroNuevo('');
          });
        }}
      >
        <label className="text-xs text-muted">
          Nombre del negocio
          <input
            className="mt-1 block w-56 rounded-boton border border-line bg-bg px-2 py-1 text-sm text-ink"
            value={nombreNuevo}
            onChange={(e) => setNombreNuevo(e.target.value)}
            placeholder="Peluquería Rosa"
          />
        </label>
        <label className="text-xs text-muted">
          Rubro (opcional)
          <input
            className="mt-1 block w-44 rounded-boton border border-line bg-bg px-2 py-1 text-sm text-ink"
            value={rubroNuevo}
            onChange={(e) => setRubroNuevo(e.target.value)}
            placeholder="belleza"
          />
        </label>
        <button
          type="submit"
          className="rounded-boton border border-action-soft-br bg-action-soft px-3 py-1.5 text-sm text-action-text"
        >
          Crear negocio (nace en prueba)
        </button>
      </form>
    <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
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
                  {/* El Select de Pulso y no el desplegable nativo: ese se
                      pinta con los colores del sistema operativo y en modo
                      noche queda blanco en una pantalla oscura. La guarda de
                      controles solo miraba apps/web, así que este sobrevivió
                      con la lista de excepciones vacía diciendo que no quedaba
                      ninguno (#537). */}
                  <Select
                    value={t.plan}
                    onValueChange={(plan) =>
                      void accion(`/platform/tenants/${t.id}/plan`, {
                        body: JSON.stringify({ plan }),
                      })
                    }
                  >
                    <SelectTrigger aria-label={`Plan de ${t.name}`} className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['base', 'crece', 'equipo'].map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  {/* Cortar el soporte antes de que venza (#480).
                      `DELETE /platform/tenants/:id/support` existía desde
                      #219 y no la llamaba nadie: se encendía por cuatro
                      horas y no había forma de apagarlo antes, aunque el
                      cliente esté viendo el aviso de que lo estamos
                      mirando. */}
                  <button
                    type="button"
                    className="rounded-boton border border-line bg-bg px-2 py-1 text-xs text-body"
                    onClick={() =>
                      void accion(`/platform/tenants/${t.id}/support`, { method: 'DELETE' })
                    }
                  >
                    Cortar soporte
                  </button>
                  <RetencionDelTenant tenantId={t.id} nombre={t.name} />
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

/**
 * La retención de un negocio (#460).
 *
 * `GET|PUT /platform/tenants/:id/retention` existía desde #331 y no la
 * llamaba nadie. La retención sale del plan, y el override por tenant —lo
 * que se le promete a un cliente que pide guardar más tiempo, o menos—
 * había que escribirlo en `tenants.settings` a mano.
 *
 * Lo que decide no es el número: es cuántas conversaciones se llevaría la
 * próxima purga con ese número puesto. Por eso el GET lo devuelve y acá se
 * muestra antes de guardar.
 */
function RetencionDelTenant({ tenantId, nombre }: { tenantId: string; nombre: string }) {
  const { session, config } = useSession();
  const [abierto, setAbierto] = useState(false);
  const [datos, setDatos] = useState<{ months: number | null; cutoff: string | null; wouldPurge: number } | null>(null);
  const [valor, setValor] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    if (!session) return;
    const res = await fetch(`${config.apiUrl}/v1/platform/tenants/${tenantId}/retention`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return;
    const cuerpo = await res.json();
    setDatos(cuerpo);
    setValor(cuerpo.months === null ? '' : String(cuerpo.months));
  }, [session, config.apiUrl, tenantId]);

  const guardar = async () => {
    if (!session) return;
    setGuardando(true);
    try {
      // Vacío significa «la del plan», y eso hay que poder volver a
      // elegirlo: un override que solo se pone obliga a recordar de
      // memoria el número que traía el plan.
      await fetch(`${config.apiUrl}/v1/platform/tenants/${tenantId}/retention`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ months: valor.trim() === '' ? null : Number(valor) }),
      });
      await cargar();
    } finally {
      setGuardando(false);
    }
  };

  if (!abierto) {
    return (
      <button
        type="button"
        className="rounded-boton border border-line bg-bg px-2 py-1 text-xs text-body"
        onClick={() => {
          setAbierto(true);
          void cargar();
        }}
      >
        Retención
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      <input
        aria-label={`Meses de retención de ${nombre}`}
        inputMode="numeric"
        placeholder="del plan"
        className="dato w-20 rounded-boton border border-line bg-bg px-2 py-1 text-right text-xs text-ink"
        value={valor}
        onChange={(e) => setValor(e.target.value.replace(/[^0-9]/g, ''))}
      />
      <button
        type="button"
        disabled={guardando}
        className="rounded-boton border border-line px-2 py-1 text-xs text-body disabled:opacity-40"
        onClick={() => void guardar()}
      >
        {guardando ? '…' : 'Guardar'}
      </button>
      {datos && (
        <span className="text-xs text-muted">
          {datos.months === null
            ? 'sin límite'
            : `${datos.months} meses · la próxima purga se llevaría ${datos.wouldPurge}`}
        </span>
      )}
    </span>
  );
}

interface ConsumoRow {
  id: string;
  name: string;
  plan: string;
  used: number;
  limit: number | null;
}

/**
 * El tope propio de un tenant (#447).
 *
 * `PUT /platform/tenants/:id/api-quota` existía y no lo llamaba nadie:
 * subirle el límite a un cliente que lo pedía era entrar a la base a mano.
 *
 * Vacío significa «el del plan», y eso hay que poder volver a elegirlo: un
 * override que solo se puede poner y no sacar obliga a recordar el número
 * que tenía el plan.
 */
function TopePropio({
  tenantId,
  nombre,
  actual,
  onGuardado,
}: {
  tenantId: string;
  nombre: string;
  actual: number | null;
  onGuardado: () => void;
}) {
  const { session, config } = useSession();
  const [valor, setValor] = useState(actual === null ? '' : String(actual));
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    if (!session) return;
    setGuardando(true);
    try {
      await fetch(`${config.apiUrl}/v1/platform/tenants/${tenantId}/api-quota`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requestsMonth: valor.trim() === '' ? null : Number(valor) }),
      });
      onGuardado();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <span className="flex items-center justify-end gap-1">
      <input
        aria-label={`Tope de API propio de ${nombre}`}
        inputMode="numeric"
        placeholder="del plan"
        className="dato w-24 rounded-boton border border-line bg-bg px-2 py-1 text-right text-xs text-ink"
        value={valor}
        onChange={(e) => setValor(e.target.value.replace(/[^0-9]/g, ''))}
      />
      <button
        type="button"
        disabled={guardando || valor === (actual === null ? '' : String(actual))}
        className="rounded-boton border border-line px-2 py-1 text-xs text-body disabled:opacity-40"
        onClick={() => void guardar()}
      >
        {guardando ? '…' : 'Guardar'}
      </button>
    </span>
  );
}

/** El consumo de API por tenant (#26): contra su tope, desde UsageMeter. */
function TablaConsumoApi() {
  const { session, config } = useSession();
  const [filas, setFilas] = useState<ConsumoRow[] | null>(null);

  const cargar = useCallback(() => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/api-usage`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.ok) setFilas(await res.json());
    });
  }, [session, config.apiUrl]);
  useEffect(cargar, [cargar]);

  if (!filas) return null;

  return (
    <div className="mt-10">
      <h2 className="mb-4 text-xl font-bold text-ink">Consumo de API (mes en curso)</h2>
      <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest text-left">
              {['Negocio', 'Plan', 'Requests', 'Tope', '% usado', 'Tope propio'].map((h) => (
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
                  {/* El override por tenant (#447): la ruta existía sin
                      pantalla, así que subirle el tope a un cliente que lo
                      pide era entrar a la base. Vacío = el del plan. */}
                  <td className="px-4 py-4 text-right">
                    <TopePropio tenantId={t.id} nombre={t.name} actual={t.limit} onGuardado={cargar} />
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
        <AvisoResultado>{aviso}</AvisoResultado>
      )}
      <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
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
        <AvisoResultado>{aviso}</AvisoResultado>
      )}
      <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
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
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
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
            <div className="mt-4 overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
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
interface PorBorrarDto {
  id: string;
  name: string;
  suspendidoDesde: string;
  diasSuspendido: number;
  avisadoEl: string | null;
  borrable: boolean;
}

/**
 * La cola de borrado (#447).
 *
 * `tenantsPorBorrar` existe y su ruta no la miraba nadie. La decisión ya
 * estaba tomada: **el sistema avisa y una persona borra**, porque es
 * irreversible y se lleva los datos de los clientes de nuestro cliente.
 * Esto es la lista para esa persona — y sin ella, el aviso automático no
 * llegaba a ningún escritorio.
 *
 * NO hay botón de borrar acá: se hace desde la fila del tenant, a
 * propósito, para que borrar no sea la acción más cercana a la lista.
 */
function ColaDeBorrado() {
  const { session, config } = useSession();
  const [filas, setFilas] = useState<PorBorrarDto[] | null>(null);

  useEffect(() => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/tenants/por-borrar`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.ok) setFilas(await res.json());
    });
  }, [session, config.apiUrl]);

  if (!filas) return null;

  return (
    <div className="mt-10">
      <h2 className="mb-1 text-xl font-bold text-ink">En cola de borrado</h2>
      <p className="mb-4 max-w-prose text-sm text-muted">
        Suspendidos hace tiempo. El sistema avisa; borrar lo hace una persona desde la fila del
        negocio, arriba. Es irreversible y se lleva los datos de los clientes de ese negocio.
      </p>
      {filas.length === 0 ? (
        <p className="rounded-campo border border-line bg-raised px-5 py-4 text-sm text-body">
          Ninguno en cola. Es la respuesta que uno quiere ver acá.
        </p>
      ) : (
        <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-rest text-left">
                {['Negocio', 'Suspendido hace', 'Avisado', 'Estado'].map((h) => (
                  <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="px-4 py-3 font-medium text-ink">{t.name}</td>
                  <td className="dato px-4 py-3 text-body">{t.diasSuspendido} días</td>
                  <td className="px-4 py-3 text-body">
                    {t.avisadoEl ? new Date(t.avisadoEl).toISOString().slice(0, 10) : 'sin avisar'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-boton border px-3 py-1 text-xs font-medium ${
                        t.borrable
                          ? 'border-bad-soft-br bg-bad-soft text-bad-text'
                          : 'border-warn-soft-br bg-warn-soft text-warn-text'
                      }`}
                    >
                      {t.borrable ? 'cumple el plazo' : 'todavía en plazo'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface PromptActivoDto {
  tenantId: string;
  agentId: string;
  nombre: string;
  promptName: string | null;
  promptVersion: string | null;
  ultimoScore: number | null;
  ultimaEval: string | null;
}

/**
 * Qué prompt está vivo en cada negocio y cómo le va (#447).
 *
 * La ruta existía sin pantalla. Es lo que permite responder «¿qué le
 * cambiamos a este cliente y le sirvió?» sin entrar a la base — y sobre
 * todo ver a los que corren SIN versión de prompt fijada, que son los que
 * se mueven solos cuando cambiamos el prompt por defecto.
 */
function PromptsVivos() {
  const { session, config } = useSession();
  const [filas, setFilas] = useState<PromptActivoDto[] | null>(null);

  useEffect(() => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/ia/prompts`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.ok) setFilas(await res.json());
    });
  }, [session, config.apiUrl]);

  if (!filas || filas.length === 0) return null;

  return (
    <div className="mt-10">
      <h2 className="mb-1 text-xl font-bold text-ink">Prompts vivos</h2>
      <p className="mb-4 max-w-prose text-sm text-muted">
        Qué versión corre en cada negocio y qué sacó en su última evaluación. Los que no tienen
        versión fijada se mueven solos cuando cambia el prompt por defecto.
      </p>
      <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest text-left">
              {['Asistente', 'Prompt', 'Versión', 'Último score', 'Medido'].map((h) => (
                <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.agentId} className="border-t border-line">
                <td className="px-4 py-3 font-medium text-ink">{f.nombre}</td>
                <td className="px-4 py-3 text-body">{f.promptName ?? 'el del código'}</td>
                <td className="px-4 py-3">
                  {f.promptVersion ? (
                    <span className="dato text-ink">{f.promptVersion}</span>
                  ) : (
                    <span className="rounded-boton border border-warn-soft-br bg-warn-soft px-3 py-1 text-xs text-warn-text">
                      sin fijar
                    </span>
                  )}
                </td>
                <td className="dato px-4 py-3 text-ink">
                  {f.ultimoScore === null ? '—' : `${Math.round(f.ultimoScore * 100)}%`}
                </td>
                <td className="px-4 py-3 text-body">
                  {f.ultimaEval ? new Date(f.ultimaEval).toISOString().slice(0, 10) : 'nunca'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface CorridaAgenteDto {
  id: string;
  tenantId: string;
  tenant: string;
  pidio: string;
  herramientas: string[];
  costUsd: number | null;
  latencyMs: number | null;
  traceId: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

interface ResumenAgenteDto {
  corridasDelMes: number;
  costoDelMesUsd: number;
  tasaDeError: number;
  negocios: number;
  latenciaP95Ms: number | null;
  apagadoGlobal: { apagado: boolean; motivo: string | null; apagadoEl: string | null };
  apagadosPorNegocio: Array<{ tenantId: string; tenant: string; motivo: string; apagadoEl: string }>;
}

/**
 * El centro de control del Agente General (#496, ADR-0025).
 *
 * Es la pieza más crítica del producto —configura negocios ajenos
 * conversando— y por eso acá hay dos cosas y no una: qué está haciendo, y
 * cómo se apaga.
 *
 * El interruptor es SUYO, no el del módulo `agents`: apagar `agents` se
 * llevaría también al copiloto de la bandeja, que es lo que atiende
 * clientes. Apagar esto deja el producto como antes —pantallas y
 * configurador—, no a oscuras. Esa diferencia es la que permite usarlo a las
 * 2 de la mañana sin pensarlo dos veces.
 */
function AgenteGeneralPanel() {
  const { session, config } = useSession();
  const [datos, setDatos] = useState<{ resumen: ResumenAgenteDto; corridas: CorridaAgenteDto[] } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch(`${config.apiUrl}/v1/platform/agente-general`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.status === 403) return;
      if (!res.ok) throw new Error(`No pudimos consultar el Agente General (HTTP ${res.status}).`);
      setDatos(await res.json());
      setAviso(null);
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [session, config.apiUrl]);
  useEffect(() => void cargar(), [cargar]);

  const interruptor = async (apagar: boolean, tenantId: string | null) => {
    if (!session || ocupado) return;
    setOcupado(true);
    try {
      const res = await fetch(
        `${config.apiUrl}/v1/platform/agente-general/${apagar ? 'apagar' : 'encender'}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(apagar ? { tenantId, motivo } : { tenantId }),
        },
      );
      if (!res.ok) {
        const cuerpo = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(cuerpo?.message ?? `Error ${res.status}`);
      }
      setMotivo('');
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setOcupado(false);
    }
  };

  if (!datos) return null;
  const { resumen, corridas } = datos;
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <div className="mt-10">
      <h2 className="mb-1 text-xl font-bold text-ink">Agente General</h2>
      <p className="mb-4 max-w-prose text-sm text-muted">
        Configura los negocios conversando, con las herramientas de cada persona. Apagarlo deja el
        producto como antes —pantallas y configurador—, no a oscuras.
      </p>

      {aviso && <AvisoResultado>{aviso}</AvisoResultado>}

      {/* El interruptor va PRIMERO: cuando se necesita, se necesita rápido. */}
      <div
        className={`mb-4 rounded-tarjeta border p-5 ${
          resumen.apagadoGlobal.apagado
            ? 'border-bad-soft-br bg-bad-soft'
            : 'border-line bg-raised'
        }`}
      >
        {resumen.apagadoGlobal.apagado ? (
          <>
            <p className="rotulo text-bad-text">Apagado para todos los negocios</p>
            <p className="mt-2 text-sm text-ink">{resumen.apagadoGlobal.motivo}</p>
            <p className="dato mt-1 text-xs text-muted">
              desde {new Date(resumen.apagadoGlobal.apagadoEl!).toLocaleString('es-CL')}
            </p>
            <button
              type="button"
              disabled={ocupado}
              className="mt-3 rounded-boton border border-good-soft-br bg-good-soft px-3 py-1.5 text-sm text-good-text disabled:opacity-40"
              onClick={() => void interruptor(false, null)}
            >
              Volver a encenderlo
            </button>
          </>
        ) : (
          <>
            <p className="rotulo">Encendido</p>
            <p className="mt-2 text-sm text-body">
              Si algo se desmadra, apágalo acá: hace efecto en la próxima pregunta de cualquiera, sin
              desplegar.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">
                Por qué lo apagas
                <input
                  className="mt-1 block w-72 rounded-boton border border-line bg-bg px-2 py-1 text-sm text-ink"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Está proponiendo cosas raras en varios negocios"
                />
              </label>
              <button
                type="button"
                disabled={ocupado || !motivo.trim()}
                className="rounded-boton border border-bad-soft-br bg-bad-soft px-3 py-1.5 text-sm text-bad-text disabled:opacity-40"
                onClick={() => void interruptor(true, null)}
              >
                Apagar para todos
              </button>
            </div>
            {/* El motivo es obligatorio: un interruptor sin motivo, a los tres
                días, nadie sabe si se puede volver a encender. */}
          </>
        )}
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['Corridas del mes', String(resumen.corridasDelMes)],
          ['Costo del mes', `USD ${resumen.costoDelMesUsd.toFixed(4)}`],
          ['Negocios que lo usan', String(resumen.negocios)],
          ['Fallidas', pct(resumen.tasaDeError)],
          ['Latencia p95', resumen.latenciaP95Ms === null ? '—' : `${(resumen.latenciaP95Ms / 1000).toFixed(1)} s`],
        ].map(([rotulo, valor]) => (
          <div key={rotulo} className="rounded-tarjeta border border-line bg-raised p-4">
            <span className="rotulo">{rotulo}</span>
            <p className="dato mt-1 text-2xl font-bold text-ink">{valor}</p>
          </div>
        ))}
      </div>

      {resumen.apagadosPorNegocio.length > 0 && (
        <div className="mb-4 rounded-tarjeta border border-warn-soft-br bg-warn-soft p-4">
          <span className="rotulo text-warn-text">Apagado en estos negocios</span>
          <ul className="mt-2 flex flex-col gap-2">
            {resumen.apagadosPorNegocio.map((a) => (
              <li key={a.tenantId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium text-ink">{a.tenant}</span>
                <span className="text-warn-text">{a.motivo}</span>
                <button
                  type="button"
                  disabled={ocupado}
                  className="ml-auto rounded-boton border border-line bg-bg px-2 py-1 text-xs text-body disabled:opacity-40"
                  onClick={() => void interruptor(false, a.tenantId)}
                >
                  Encender
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest text-left">
              {['Cuándo', 'Negocio', 'Qué le pidieron', 'Herramientas', 'Demoró', 'USD', ''].map((h) => (
                <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {corridas.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-sm text-muted">
                  Todavía nadie le ha pedido nada este mes.
                </td>
              </tr>
            )}
            {corridas.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="dato px-4 py-3 text-xs text-muted">
                  {new Date(c.createdAt).toLocaleString('es-CL', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td className="px-4 py-3 font-medium text-ink">{c.tenant}</td>
                <td className="max-w-xs px-4 py-3 text-body">{c.pidio}</td>
                <td className="px-4 py-3">
                  {c.herramientas.length === 0 ? (
                    <span className="text-xs text-muted">ninguna</span>
                  ) : (
                    <span className="dato text-xs text-action-text">{c.herramientas.join(' · ')}</span>
                  )}
                </td>
                <td className="dato px-4 py-3 text-right text-ink">
                  {c.latencyMs === null ? '—' : `${(c.latencyMs / 1000).toFixed(1)} s`}
                </td>
                <td className="dato px-4 py-3 text-right text-ink">
                  {c.costUsd === null ? '—' : c.costUsd.toFixed(4)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {c.status !== 'ok' && (
                      <span className="rounded-boton border border-bad-soft-br bg-bad-soft px-2 py-0.5 text-xs text-bad-text">
                        {c.status}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={ocupado}
                      className="rounded-boton border border-line bg-bg px-2 py-1 text-xs text-body disabled:opacity-40"
                      onClick={() => {
                        setMotivo(`Revisando lo que hizo en ${c.tenant}`);
                        void interruptor(true, c.tenantId);
                      }}
                    >
                      Apagar en este negocio
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
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
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
        <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
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
          <div className="overflow-x-auto pulso-panel rounded-tarjeta border border-line bg-raised">
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
  const firma = useMarcaSvg(marcaSvg);
  return (
    <SessionProvider config={config}>
      <RequireSession>
        <div className="pulso-admin min-h-screen">
          <header className="border-b border-line bg-raised">
            <div className="mx-auto flex max-w-contenido flex-wrap items-center gap-4 px-4 py-3">
              <a href="/" className="marca" aria-label="VoxTi Labs, panel de IAxTi"
                 dangerouslySetInnerHTML={{ __html: firma }} />
              <span className="rotulo">SuperAdmin</span>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <ModeToggle />
                <CerrarSesion />
              </div>
            </div>
          </header>
          <main className="pulso-content mx-auto max-w-contenido">
            <header className="pulso-hero mb-8">
              <div>
                <span className="pulso-eyebrow">IAxTi · Administración</span>
                <h1>Tu plataforma, en perspectiva.</h1>
                <p className="mt-3 max-w-prose text-sm text-body">Negocios, planes y consumo. El contexto para acompañar a cada equipo.</p>
              </div>
              <MarcaJelly />
            </header>
            <h2 className="mb-4 text-xl font-bold text-ink">Tenants</h2>
            <TablaTenants />
            <TablaPlanes />
            <TablaModulos />
            <TablaConsumoApi />
            <AuditGlobal />
            {/* El Agente General va ANTES del centro de IA: es la pieza más
                crítica, y su interruptor es lo primero que alguien busca
                cuando algo va mal (#496). */}
            <AgenteGeneralPanel />
            <CentroIA />
            <PromptsVivos />
            <ColaDeBorrado />
            <SeguridadYSalud />
          </main>
        </div>
      </RequireSession>
    </SessionProvider>
  );
}
