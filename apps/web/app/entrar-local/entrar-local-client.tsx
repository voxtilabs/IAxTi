'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Button } from '@iaxti/ui/react';
import type { PublicConfig } from '../../lib/config';

/**
 * Entrar como un usuario del seed (#1047), en dos pasos a la vista:
 * pedirle la sesión firmada a auth-local y dársela a supabase-js —
 * `setSession` la guarda y agenda el refresh, contra el mismo auth-local.
 */
const USUARIOS = [
  { email: 'duena@demo-iaxti.cl', rol: 'ADMIN', quien: 'La dueña' },
  { email: 'vendedor@demo-iaxti.cl', rol: 'USER', quien: 'El vendedor' },
] as const;

export function EntrarLocal({ config }: { config: PublicConfig }) {
  const [estado, setEstado] = useState<string | null>(null);

  async function entrar(email: string) {
    setEstado(`Firmando la sesión de ${email}…`);
    try {
      const res = await fetch(`${config.supabaseUrl}/entrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        setEstado(err.message ?? 'auth-local no quiso firmar. ¿Corriste pnpm seed?');
        return;
      }
      const sesion = (await res.json()) as { access_token: string; refresh_token: string };
      const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
      const { error } = await supabase.auth.setSession({
        access_token: sesion.access_token,
        refresh_token: sesion.refresh_token,
      });
      if (error) {
        setEstado(`supabase-js no aceptó la sesión: ${error.message}`);
        return;
      }
      // El tenant no se elige acá: el switcher ya cae al primero de /v1/me
      // cuando no hay uno guardado — dos códigos eligiendo serían dos
      // criterios.
      window.location.href = '/';
    } catch (e) {
      setEstado(
        `No llegué a auth-local (${config.supabaseUrl}). ¿Está arriba el docker compose? Detalle: ${String(e)}`,
      );
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm rounded-tarjeta border border-line bg-raised p-6">
        <h1 className="font-titulo text-lg text-ink">Entrar al ambiente local</h1>
        <p className="mt-1 text-sm text-body">
          Sesión firmada por auth-local, solo para desarrollo. Los usuarios son los del seed de
          demostración.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {USUARIOS.map((u, i) => (
            <Button
              key={u.email}
              variant={i === 0 ? undefined : 'soft'}
              data-testid={`entrar-${u.rol.toLowerCase()}`}
              onClick={() => void entrar(u.email)}
            >
              {u.quien} · {u.rol}
            </Button>
          ))}
        </div>
        {estado && <p className="mt-3 text-sm text-muted">{estado}</p>}
      </div>
    </main>
  );
}
