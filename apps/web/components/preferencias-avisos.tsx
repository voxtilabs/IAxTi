'use client';

import { AvisoResultado, Checkbox, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Skeleton, useSession } from '@iaxti/ui/react';
// Las dos: `useSelectedTenant` para el render —que tiene que seguir al
// selector y no puede leer `localStorage` mientras dibuja— y `selectedTenant`
// suelto para los manejadores, donde se lee en el momento de la acción y
// siempre es el valor vigente (#789).
import { selectedTenant, useSelectedTenant } from './tenant-switcher';
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
  // En el render va el hook, no `selectedTenant()` suelto: tiene que seguir al
  // selector de negocio. En los manejadores sigue yendo el suelto, que lee el
  // valor vigente en el momento de la acción (#789).
  const tenant = useSelectedTenant();
  // `no_pudimos` existe porque `no_disponible` devuelve `null` y se lleva la
  // sección entera (#1114). Que el servidor no tenga llaves VAPID y que no
  // hayamos podido preguntárselo son dos cosas, y confundirlas hace que un
  // fallo BORRE una función en vez de reportarla. El comentario de `activar()`
  // ya decía esto mismo; el efecto de acá arriba no lo aplicaba.
  const [estado, setEstado] = useState<
    'cargando' | 'no_disponible' | 'no_pudimos' | 'listo' | 'activo' | 'negado'
  >('cargando');
  const [aviso, setAviso] = useState<string | null>(null);
  /**
   * Si los avisos están LLEGANDO a este dispositivo (#698).
   *
   * «Activo» decía que el navegador está suscrito, no que el aviso llegue.
   * `last_ok_at` y `failed_at` se escribían en cada envío y nada las leía, así
   * que una suscripción muerta hace semanas se veía igual que una sana: el
   * dueño no recibía nada y el producto creía que estaba avisando.
   */
  const [salud, setSalud] = useState<SaludPushDto | null>(null);

  useEffect(() => {
    if (!session) return;
    const soportado =
      typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
    if (!soportado) {
      setEstado('no_disponible');
      return;
    }
    if (!tenant) return;
    // Por `apiFetch` y no por `fetch` a mano: es lo único que garantiza el
    // `X-Tenant-Id`. Las tres llamadas de esta pantalla lo omitían, la API
    // contestaba 401 TENANT_REQUIRED con un JSON válido —así que `.json()` no
    // fallaba—, `publicKey` quedaba `undefined` y la sección desaparecía. La
    // función llevaba desplegada todo ese tiempo, invisible (#1114).
    void (async () => {
      let clave: { publicKey: string | null };
      try {
        clave = await apiFetch<{ publicKey: string | null }>(
          config, session, tenant, '/notifications/push/clave',
        );
      } catch {
        setEstado('no_pudimos');
        return;
      }
      if (!clave.publicKey) {
        setEstado('no_disponible');
        return;
      }
      const registro = await navigator.serviceWorker.getRegistration();
      const suscripcion = await registro?.pushManager.getSubscription();
      setEstado(suscripcion ? 'activo' : Notification.permission === 'denied' ? 'negado' : 'listo');
      if (!suscripcion) return;
      // La salud se pide solo si hay suscripción: sin ella no hay nada que
      // contar, y un fallo acá no puede romper la pantalla del permiso.
      try {
        setSalud(await apiFetch<SaludPushDto>(config, session, tenant, '/notifications/push/salud'));
      } catch {
        // Queda sin el diagnóstico de salud, que es un extra; el permiso
        // —que es lo que esta pantalla hace— sigue funcionando.
      }
    })();
    // `tenant` en las dependencias: cambiar de negocio vuelve a preguntar. Sin
    // eso, la respuesta del negocio anterior se quedaba pegada.
  }, [session, config, tenant]);

  async function activar() {
    if (!session) return;
    setAviso(null);
    try {
      // Mirar la respuesta antes del `.json()`, y acá no es por prolijidad:
      // iba directo al cuerpo, así que un 500 caía en el `if` de abajo y el
      // usuario leía «el servidor todavía no tiene el push configurado» —un
      // diagnóstico falso, que manda a revisar una configuración que está
      // bien. No pudimos PREGUNTAR y no está CONFIGURADO son dos cosas.
      const clave = await apiFetch<{ publicKey: string | null }>(
        config, session, selectedTenant() ?? '', '/notifications/push/clave',
      ).catch(() => {
        throw new Error('No pudimos preguntarle al servidor por los avisos.');
      });
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
      // Por `apiFetch` como las demás (#1114). Esta SÍ ponía el negocio a
      // mano y funcionaba; el problema de armar la URL a mano no es que
      // siempre falle, es que depende de que alguien se acuerde — y en este
      // mismo archivo tres de cinco no se acordaron.
      await apiFetch(config, session, selectedTenant() ?? '', '/notifications/push', {
        method: 'POST',
        body: JSON.stringify(suscripcion.toJSON()),
      }).catch(() => {
        throw new Error('No pudimos registrar este navegador.');
      });
      setEstado('activo');
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  /**
   * Corta el push en ESTE navegador. Se hacen las dos cosas: darse de baja
   * en el navegador y borrar la suscripción en el servidor. Si solo se
   * hiciera lo segundo, el navegador seguiría suscrito y el servidor le
   * mandaría a una suscripción que ya no reconoce.
   *
   * El comentario de arriba decía «las dos cosas» y el código solo
   * comprobaba una (#588, punto 4): el DELETE iba sin mirar `res.ok`, así
   * que un rechazo del servidor terminaba igual en «listo». El resultado
   * era el caso inverso al que el comentario se cuidaba — el navegador
   * dado de baja y el servidor con el registro vivo.
   *
   * Qué se hace con eso importa, porque las dos mitades no valen lo
   * mismo. Lo que de verdad apaga los avisos es `unsubscribe()`: sin él
   * el navegador sigue recibiendo. Así que la baja local se hace siempre,
   * incluso si el servidor falla — abortarla dejaría al usuario con los
   * avisos encendidos después de haber pedido apagarlos. Lo que se avisa
   * es la otra mitad: que quedó un registro muerto allá.
   */
  async function desactivar() {
    if (!session) return;
    setAviso(null);
    try {
      const registro = await navigator.serviceWorker.getRegistration();
      const suscripcion = await registro?.pushManager.getSubscription();
      let servidorLimpio = true;
      if (suscripcion) {
        servidorLimpio = await apiFetch(config, session, selectedTenant() ?? '', '/notifications/push', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: suscripcion.endpoint }),
        }).then(() => true, () => false);
        await suscripcion.unsubscribe();
      }
      setEstado('listo');
      if (!servidorLimpio) {
        setAviso(
          'Este navegador ya no recibe avisos, pero no pudimos borrar el registro en el servidor. Vuelve a intentarlo más tarde.',
        );
      }
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  if (estado === 'cargando' || estado === 'no_disponible') return null;
  if (estado === 'no_pudimos') {
    return (
      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-4">
        <p className="text-sm text-body">
          No pudimos preguntarle al servidor si este dispositivo puede recibir avisos. Vuelve a
          cargar la página; si sigue igual, avísanos.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-4">
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
      {/* Apagarlos (#480). `DELETE /notifications/push` existe desde #75 y
          no la llamaba nadie: activar era un botón y apagar había que ir a
          buscarlo a la configuración del navegador —donde apagarlo quema
          el permiso para siempre y volver a encenderlo es un trámite. */}
      {estado === 'activo' && (
        <button
          type="button"
          onClick={() => void desactivar()}
          className="mt-2 rounded-boton border border-line-strong px-3 py-1.5 text-sm font-medium text-body"
        >
          Dejar de recibirlos aquí
        </button>
      )}
      {/* No estamos pudiendo avisarte acá (#698), criterio 3. Tres fallas
          seguidas y no una: la red de un celular falla sola, y un aviso falso
          enseña a ignorar los verdaderos — que es el problema que este arreglo
          viene a resolver, por el otro lado. */}
      {estado === 'activo' && salud?.dispositivos.some((d) => d.avisarQueNoLlega) && (
        <div className="mt-3">
          <AvisoResultado tono="warning" persistente>
            No estamos pudiendo avisarte en este dispositivo. Prueba apagando y volviendo a activar
            los avisos acá; si sigue igual, revisa los permisos del navegador.
          </AvisoResultado>
        </div>
      )}
      {aviso && <p className="mt-2 text-sm text-warn-text">{aviso}</p>}
    </div>
  );
}

/**
 * Si los avisos están llegando (#698).
 *
 * `negocio` es el diagnóstico del criterio 4: cuántos dispositivos del negocio
 * están fallando. No va en `/ready` —un dispositivo que no recibe avisos no es
 * razón para sacar la API de rotación— sino acá, donde alguien puede hacer algo.
 */
interface SaludPushDto {
  dispositivos: Array<{
    id: string;
    userAgent: string | null;
    ultimoOkEl: string | null;
    ultimaFallaEl: string | null;
    fallasSeguidas: number;
    avisarQueNoLlega: boolean;
  }>;
  negocio: {
    dispositivos: number;
    fallando: number;
    archivadas: number;
    /** Por qué se archivaron. «El servicio dijo que ya no existe» en varios a
     *  la vez es una señal distinta de que alguien quitó su dispositivo. */
    archivadasPorMotivo: Array<{ motivo: string; n: number }>;
  };
}

export function PreferenciasAvisos() {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [prefs, setPrefs] = useState<PrefDto[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

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
      <EncabezadoDePagina
        rotulo="NOTIFICACIONES"
        titulo="Qué avisos recibes"
      />
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
