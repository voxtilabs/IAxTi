'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  AvisoResultado,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Formulario,
  Input,
  useSession,
} from '@iaxti/ui/react';
import { useSelectedTenant } from '../tenant-switcher';
import { ApiError, apiFetch, avisoDe, type Aviso } from '../../lib/api';

/**
 * Agregar una persona a mano (#1395).
 *
 * La lista solo se llenaba con quien escribía o con una planilla importada:
 * al cliente que dejó su número en un papel no había dónde meterlo sin pasar
 * por Excel. El teléfono es lo único obligatorio —nombre y correo se agregan
 * después, corrigiendo la ficha— porque es lo único que identifica a la
 * persona en WhatsApp.
 */

/** El `contactId` dentro de los `details` de un 409, si vino. */
function contactIdDe(details: unknown[]): string | null {
  for (const d of details) {
    if (d && typeof d === 'object' && 'contactId' in d) {
      const v = (d as { contactId?: unknown }).contactId;
      if (typeof v === 'string' && v) return v;
    }
  }
  return null;
}

export function DialogoNuevoContacto({
  abierto,
  onCerrar,
  onCreado,
}: {
  abierto: boolean;
  onCerrar: () => void;
  onCreado: (nombre: string | null) => void;
}) {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [telefono, setTelefono] = useState('');
  const [nombre, setNombre] = useState('');
  const [correo, setCorreo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<Aviso | null>(null);
  /** El contacto que ya tenía ese teléfono, cuando el 409 lo trae. */
  const [duplicado, setDuplicado] = useState<string | null>(null);

  // Reabrir el diálogo arranca limpio: el error de la vez anterior ya hizo
  // su trabajo y volver a verlo confunde.
  useEffect(() => {
    if (!abierto) { setError(null); setDuplicado(null); }
  }, [abierto]);

  async function crear(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || guardando || !telefono.trim()) return;
    setGuardando(true);
    setError(null);
    setDuplicado(null);
    try {
      const creado = await apiFetch<{ id: string; name: string | null }>(config, session, tenant, '/contacts', {
        method: 'POST',
        // La llave la pide la regla de API para todo POST que crea: si la
        // petición se reintentara, no nacerían dos contactos iguales.
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        // Los opcionales viajan solo con valor: mandarlos vacíos confundiría
        // «no lo sé» con «no tiene».
        body: JSON.stringify({
          phone: telefono.trim(),
          ...(nombre.trim() ? { name: nombre.trim() } : {}),
          ...(correo.trim() ? { email: correo.trim() } : {}),
        }),
      });
      setTelefono('');
      setNombre('');
      setCorreo('');
      onCreado(creado.name ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONTACT_EXISTS') {
        setDuplicado(contactIdDe(err.details));
        // El mensaje del dominio ya dice qué hacer; el rastro no ayuda acá
        // porque lo que sigue es un clic, no un reporte.
        setError({ texto: err.message, rastro: null });
      } else {
        setError(avisoDe(err));
      }
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open={abierto} onOpenChange={(v: boolean) => { if (!v) onCerrar(); }}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nuevo contacto</DialogTitle>
          <DialogDescription>Su teléfono, y su nombre y correo si ya los tienes.</DialogDescription>
        </DialogHeader>
        <Formulario className="flex flex-col gap-3" onSubmit={crear}>
          <label className="flex flex-col gap-1 text-sm text-body">
            Teléfono
            <Input
              required
              inputMode="tel"
              placeholder="+56912345678"
              className="dato"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Nombre
            <Input value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Correo
            <Input type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} />
          </label>
          <p className="text-xs text-muted">
            Nace sin permiso para que le escribas primero: lo tendrá cuando te escriba o te dé su
            autorización.
          </p>
          {error && (
            <AvisoResultado tono="error" persistente>
              {error.texto}
              {error.rastro && <span className="dato block break-all">{error.rastro}</span>}
              {duplicado && (
                <>
                  {' '}
                  <a href={`/contactos/${duplicado}`} className="underline">
                    Ver el contacto
                  </a>
                </>
              )}
            </AvisoResultado>
          )}
          <span className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secundario" onClick={onCerrar}>
              Cancelar
            </Button>
            <Button type="submit" disabled={guardando || !telefono.trim()}>
              {guardando ? 'Agregando…' : 'Agregar contacto'}
            </Button>
          </span>
        </Formulario>
      </DialogContent>
    </Dialog>
  );
}
