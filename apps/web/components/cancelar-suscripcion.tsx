'use client';

import { useState } from 'react';
import {
  AvisoResultado,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

/**
 * Cancelar en un clic (#460, SPEC §6).
 *
 * `POST /billing/cancelar` existe desde #67 y no la llamaba nadie: cancelar
 * había que pedirlo por escrito, que es exactamente lo que la spec no
 * quería. Un producto que se contrata solo y se cancela hablando con
 * alguien no se cancela: se abandona, y la cuenta sigue cobrando.
 *
 * La exportación no se ofrece aparte ni "después": la ruta la GENERA en la
 * misma transacción y la devuelve entera, así que el archivo se descarga
 * en el mismo gesto. Pedirla después de cancelar sería pedirle al cliente
 * que confíe justo cuando decidió dejar de hacerlo.
 */
interface RespuestaCancelacion {
  cancelAt: string;
  mensaje: string;
  exportacion: { generadoEl: string; resumen: Record<string, number> };
}

export function CancelarSuscripcion({ onCancelada }: { onCancelada?: () => void }) {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [hecho, setHecho] = useState<RespuestaCancelacion | null>(null);

  if (!tenant) return null;

  const cancelar = async () => {
    if (!session || ocupado) return;
    setOcupado(true);
    setAviso(null);
    try {
      const r = await apiFetch<RespuestaCancelacion>(config, session, tenant, '/billing/cancelar', {
        method: 'POST',
        body: JSON.stringify(motivo.trim() ? { motivo: motivo.trim() } : {}),
      });
      // El archivo se guarda con la respuesta en la mano. Si el navegador
      // lo bloqueara, la exportación sigue disponible en "Llevarte tus
      // datos": esto es un atajo, no el único camino.
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(r.exportacion, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `iaxti-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setHecho(r);
      setAbierto(false);
      onCancelada?.();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos cancelar. Inténtalo de nuevo.');
    } finally {
      setOcupado(false);
    }
  };

  if (hecho) {
    return (
      <section className="mt-4 rounded-campo border border-line bg-rest p-4">
        <p className="rotulo">Suscripción cancelada</p>
        <p className="mt-1 max-w-prose text-sm text-body">{hecho.mensaje}</p>
        <p className="mt-2 text-sm text-muted">
          Te descargamos tu archivo con todo lo tuyo. Si se perdió, lo puedes volver a bajar en
          «Llevarte tus datos» mientras la cuenta siga abierta.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-4 rounded-campo border border-line bg-rest p-4">
      <p className="rotulo">Cancelar la suscripción</p>
      <p className="mt-1 max-w-prose text-sm text-body">
        Se cancela acá mismo, sin llamar a nadie. La cuenta queda activa hasta el final del período
        que ya pagaste y después pasa a solo lectura: tus conversaciones y contactos siguen ahí,
        pero no se envían mensajes.
      </p>
      <Button className="mt-3" variant="secundario" onClick={() => setAbierto(true)}>
        Cancelar mi suscripción
      </Button>

      {aviso && (
        <AvisoResultado tono="error" persistente>
          {aviso}
        </AvisoResultado>
      )}

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar la suscripción</DialogTitle>
            <DialogDescription>
              Antes de cerrar te descargamos todo lo tuyo: contactos, conversaciones,
              oportunidades, citas y facturas.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-sm text-body">
            ¿Por qué te vas? (opcional)
            <Input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Nos sirve para mejorar"
            />
          </label>
          <DialogFooter>
            <Button variant="secundario" onClick={() => setAbierto(false)}>
              Mejor no
            </Button>
            <Button disabled={ocupado} onClick={() => void cancelar()}>
              {ocupado ? 'Cancelando…' : 'Cancelar y descargar mis datos'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
