'use client';

import { AvisoResultado, Checkbox } from '@iaxti/ui/react';

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
  push: boolean;
  whatsapp: boolean;
  bloqueada: boolean;
  whatsappNoAplica: boolean;
}

const NOMBRES: Record<string, string> = {
  conversacion_sin_dueno: 'Conversación nueva sin dueño',
  sla_vencido: 'Primera respuesta fuera de plazo',
  mencion: 'Me mencionaron en una nota',
  tarea_vencida: 'Actividad vencida',
  cuota_ia: 'Cuota de IA por agotarse',
  calidad_numero: 'Calidad del número de WhatsApp',
  pago_recibido: 'Pago recibido',
};

/**
 * El permiso de push se pide EN CONTEXTO, no al entrar (#78): pedirlo de
 * golpe al cargar la app es la forma más rápida de que lo nieguen para
 * siempre. Y si el servidor no tiene llaves VAPID, ni se ofrece — un
 * permiso quemado no se recupera.
 */
function PermisoPush() {
  const { session, config } = useSession();
  const [estado, setEstado] = useState<'cargando' | 'no_disponible' | 'listo' | 'activo' | 'negado'>(
    'cargando',
  );
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const soportado =
      typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
    if (!soportado) {
      setEstado('no_disponible');
      return;
    }
    void fetch(`${config.apiUrl}/v1/notifications/push/clave`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then(async (d: { publicKey: string | null }) => {
        if (!d.publicKey) {
          setEstado('no_disponible');
          return;
        }
        const registro = await navigator.serviceWorker.getRegistration();
        const suscripcion = await registro?.pushManager.getSubscription();
        setEstado(
          suscripcion ? 'activo' : Notification.permission === 'denied' ? 'negado' : 'listo',
        );
      })
      .catch(() => setEstado('no_disponible'));
  }, [session, config.apiUrl]);

  async function activar() {
    if (!session) return;
    setAviso(null);
    try {
      const clave = await fetch(`${config.apiUrl}/v1/notifications/push/clave`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).then((r) => r.json() as Promise<{ publicKey: string | null }>);
      if (!clave.publicKey) throw new Error('El servidor todavía no tiene el push configurado.');

      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        setEstado('negado');
        return;
      }
      const registro = await navigator.serviceWorker.register('/sw.js');
      const suscripcion = await registro.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: clave.publicKey,
      });
      const res = await fetch(`${config.apiUrl}/v1/notifications/push`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          'X-Tenant-Id': selectedTenant() ?? '',
        },
        body: JSON.stringify(suscripcion.toJSON()),
      });
      if (!res.ok) throw new Error('No pudimos registrar este navegador.');
      setEstado('activo');
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  if (estado === 'cargando' || estado === 'no_disponible') return null;
  return (
    <div className="mt-4 rounded-tarjeta border border-line bg-raised p-4">
      <p className="text-sm text-body">
        {estado === 'activo'
          ? 'Este navegador ya recibe avisos aunque tengas IAxTi cerrado.'
          : estado === 'negado'
            ? 'Bloqueaste los avisos en este navegador. Puedes volver a permitirlos desde la barra de direcciones.'
            : 'Recibe los avisos en este dispositivo aunque tengas IAxTi cerrado.'}
      </p>
      {estado === 'listo' && (
        <button
          type="button"
          onClick={() => void activar()}
          className="mt-2 rounded-boton bg-action px-3 py-1.5 text-sm font-medium text-action-contrast"
        >
          Activar en este dispositivo
        </button>
      )}
      {aviso && <p className="mt-2 text-sm text-warn-text">{aviso}</p>}
    </div>
  );
}

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

  async function guardar(pref: PrefDto, campo: 'campana' | 'correo' | 'push' | 'whatsapp', valor: boolean) {
    if (!session || !tenant) return;
    setAviso(null);
    const nueva = { ...pref, [campo]: valor };
    setPrefs((prev) => prev?.map((p) => (p.type === pref.type ? nueva : p)) ?? null);
    try {
      await apiFetch(config, session, tenant, '/notifications/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          type: pref.type,
          campana: nueva.campana,
          correo: nueva.correo,
          push: nueva.push,
          whatsapp: nueva.whatsapp,
        }),
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
      <h1 className="mt-1 font-display text-titulo font-bold text-ink">Qué avisos recibes</h1>
      <p className="mt-1 text-sm text-body">Elige por tipo y por canal. El correo llega cuando el negocio tenga su remitente configurado.</p>

      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}

      <div className="mt-6 overflow-hidden rounded-tarjeta border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-rest">
              <th className="rotulo px-4 py-2 text-left">Aviso</th>
              <th className="rotulo px-4 py-2">Campana</th>
              <th className="rotulo px-4 py-2">Correo</th>
              <th className="rotulo px-4 py-2">Push</th>
              <th className="rotulo px-4 py-2">WhatsApp</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((p) => (
              <tr key={p.type} className="border-t border-line">
                <td className="px-4 py-3 text-body">
                  {NOMBRES[p.type] ?? p.type}
                  {p.bloqueada && <Badge role="warn" className="ml-2">Crítico</Badge>}
                </td>
                {(['campana', 'correo', 'push', 'whatsapp'] as const).map((campo) => (
                  <td key={campo} className="px-4 py-3 text-center">
                    {campo === 'whatsapp' && p.whatsappNoAplica ? (
                      // Por WhatsApp solo salen los críticos: un guion es más
                      // honesto que una casilla que no hace nada.
                      <span className="text-muted" title="Por WhatsApp solo salen los avisos críticos">
                        —
                      </span>
                    ) : (
                      <Checkbox
                        aria-label={`${campo} para ${NOMBRES[p.type] ?? p.type}`}
                        checked={p[campo]}
                        disabled={p.bloqueada && campo !== 'push' && campo !== 'whatsapp'}
                        onCheckedChange={(marcado) => void guardar(p, campo, marcado === true)}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        Los avisos críticos para quien administra no se pueden silenciar en campana y correo:
        protegen el negocio. El push depende de un permiso del navegador que puedes quitar cuando
        quieras, y por WhatsApp solo salen los críticos, a tu número del perfil.
      </p>
      <PermisoPush />
    </div>
  );
}
