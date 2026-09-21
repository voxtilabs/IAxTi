'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useEffect, useState } from 'react';
import { Button, SessionProvider, useSession, type PublicConfig } from '@iaxti/ui/react';
import { apiFetch } from '../lib/api';

// Canjear una invitación (#28).
//
// La invitación devolvía un enlace `/invitacion/<token>` y esta página NO
// EXISTÍA: el enlace llevaba a un 404. Tampoco había endpoint para
// canjearlo. O sea que se podía invitar y nadie podía entrar.
//
// Quien llega acá puede no tener sesión —es alguien nuevo— así que primero
// se le pide entrar, y el token se conserva para canjearlo después.

function Canje({ token }: { token: string }) {
  const { config, session } = useSession();
  const [estado, setEstado] = useState<'mirando' | 'sin-sesion' | 'canjeando' | 'listo' | 'error'>('mirando');
  const [detalle, setDetalle] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setEstado('sin-sesion');
      return;
    }
    let vivo = true;
    void (async () => {
      setEstado('canjeando');
      try {
        // Sin X-Tenant-Id: el token dice a qué negocio. Pedírselo a alguien
        // que todavía no entró sería pedirle lo que viene a conseguir.
        await apiFetch(config, session, '', `/invitaciones/${token}/aceptar`, { method: 'POST' });
        if (vivo) setEstado('listo');
      } catch (e) {
        if (!vivo) return;
        setDetalle((e as Error).message);
        setEstado('error');
      }
    })();
    return () => {
      vivo = false;
    };
  }, [config, session, token]);

  if (estado === 'listo') {
    return (
      <>
        <h1 className="mt-6 text-titulo font-extrabold text-ink">Ya estás dentro</h1>
        <p className="mb-6 mt-1 text-sm text-body">
          Tu cuenta quedó con acceso al negocio que te invitó.
        </p>
        <a href="/bandeja">
          <Button>Ir a la bandeja</Button>
        </a>
      </>
    );
  }

  if (estado === 'sin-sesion') {
    return (
      <>
        <h1 className="mt-6 text-titulo font-extrabold text-ink">Te invitaron a un negocio</h1>
        <p className="mb-6 mt-1 text-sm text-body">
          Entra con tu correo y te damos el acceso. Usa el mismo correo al que llegó la invitación.
        </p>
        <Button
          onClick={() => {
            // El token se guarda para volver acá después de entrar: mandarlo
            // al login a secas le haría perder la invitación.
            try {
              sessionStorage.setItem('iaxti:invitacion', token);
            } catch {
              /* sin storage igual puede volver por el enlace del correo */
            }
            window.location.href = `/login?volver=/invitacion/${token}`;
          }}
        >
          Entrar con mi correo
        </Button>
      </>
    );
  }

  if (estado === 'error') {
    return (
      <>
        <h1 className="mt-6 text-titulo font-extrabold text-ink">Esta invitación no sirve</h1>
        <AvisoResultado tono="error">
          {detalle}
        </AvisoResultado>
        <p className="text-sm text-body">
          Pídele a quien te invitó que te mande una nueva.
        </p>
      </>
    );
  }

  return <p className="mt-6 text-sm text-muted">Un segundo…</p>;
}

export function AceptarInvitacion({
  config,
  marcaSvg,
  token,
}: {
  config: PublicConfig;
  marcaSvg: string;
  token: string;
}) {
  return (
    <SessionProvider config={config}>
      <main className="flex min-h-screen items-center justify-center bg-bg px-4">
        <div className="w-full max-w-md pulso-panel rounded-tarjeta border border-line bg-raised p-8">
          <span className="marca" aria-hidden dangerouslySetInnerHTML={{ __html: marcaSvg }} />
          <Canje token={token} />
        </div>
      </main>
    </SessionProvider>
  );
}
