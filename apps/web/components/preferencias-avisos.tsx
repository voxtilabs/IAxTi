'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Preferencias de avisos (#55): cada quien elige por tipo y canal; las
// críticas quedan bloqueadas para quien administra.

interface PrefDto {
  type: string;
  campana: boolean;
  correo: boolean;
  bloqueada: boolean;
}

const NOMBRES: Record<string, string> = {
  conversacion_sin_dueno: 'Conversación nueva sin dueño',
  sla_vencido: 'Primera respuesta fuera de plazo',
  mencion: 'Me mencionaron en una nota',
  tarea_vencida: 'Actividad vencida',
  cuota_ia: 'Cuota de IA por agotarse',
  calidad_numero: 'Calidad del número de WhatsApp',
};

export function PreferenciasAvisos() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PrefDto[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setPrefs(await apiFetch<PrefDto[]>(config, session, tenant, '/notifications/preferences'));
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  async function guardar(pref: PrefDto, campo: 'campana' | 'correo', valor: boolean) {
    if (!session || !tenant) return;
    setAviso(null);
    const nueva = { ...pref, [campo]: valor };
    setPrefs((prev) => prev?.map((p) => (p.type === pref.type ? nueva : p)) ?? null);
    try {
      await apiFetch(config, session, tenant, '/notifications/preferences', {
        method: 'PUT',
        body: JSON.stringify({ type: pref.type, campana: nueva.campana, correo: nueva.correo }),
      });
    } catch (err) {
      setAviso((err as Error).message);
      await cargar();
    }
  }

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (!prefs) return <div className="max-w-xl"><Skeleton className="h-40" /></div>;

  return (
    <div className="max-w-xl">
      <p className="rotulo">Notificaciones</p>
      <h1 className="mt-1 font-display text-xl font-bold text-ink">Qué avisos recibes</h1>
      <p className="mt-1 text-sm text-body">Elige por tipo y por canal. El correo llega cuando el negocio tenga su remitente configurado.</p>

      {aviso && (
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          {aviso}
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-tarjeta border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest">
              <th className="rotulo px-4 py-2 text-left">Aviso</th>
              <th className="rotulo px-4 py-2">Campana</th>
              <th className="rotulo px-4 py-2">Correo</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((p) => (
              <tr key={p.type} className="border-t border-line">
                <td className="px-4 py-3 text-body">
                  {NOMBRES[p.type] ?? p.type}
                  {p.bloqueada && <Badge role="warn" className="ml-2">Crítico</Badge>}
                </td>
                {(['campana', 'correo'] as const).map((campo) => (
                  <td key={campo} className="px-4 py-3 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${campo} para ${NOMBRES[p.type] ?? p.type}`}
                      className="h-5 w-5 accent-[color:var(--action)]"
                      checked={p[campo]}
                      disabled={p.bloqueada}
                      onChange={(e) => void guardar(p, campo, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        Los avisos críticos para quien administra no se pueden silenciar: protegen el negocio.
      </p>
    </div>
  );
}
