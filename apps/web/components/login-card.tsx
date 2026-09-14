'use client';

import { useState, type FormEvent } from 'react';
import type { PublicConfig } from '../lib/config';
import { SessionProvider, useSession } from './session';

function Formulario() {
  const { supabase } = useSession();
  const [email, setEmail] = useState('');
  const [estado, setEstado] = useState<'inicial' | 'enviado' | 'error'>('inicial');

  async function enviarEnlace(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setEstado(error ? 'error' : 'enviado');
  }

  async function conGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }

  return (
    <form onSubmit={enviarEnlace} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Tu correo
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="duena@tunegocio.cl"
          className="h-control rounded-campo border border-line-strong bg-field px-4 text-base text-ink placeholder:text-faint"
        />
      </label>

      {estado === 'enviado' && (
        <p className="rounded-campo border border-action-soft-br bg-action-soft px-5 py-4 text-sm text-action-text">
          <span className="font-medium">Te enviamos el enlace.</span> Ábrelo desde este mismo
          dispositivo para entrar.
        </p>
      )}
      {estado === 'error' && (
        <p className="rounded-campo border border-bad-soft-br bg-bad-soft px-5 py-4 text-sm text-bad-text">
          <span className="font-medium">No pudimos enviar el enlace.</span> Revisa el correo e
          intenta de nuevo.
        </p>
      )}

      <button
        type="submit"
        className="h-control rounded-boton bg-action px-8 font-display text-base font-bold text-white hover:bg-action-hover"
      >
        Enviarme el enlace
      </button>
      <button
        type="button"
        onClick={() => void conGoogle()}
        className="h-control rounded-boton border border-line-strong px-8 text-base text-ink"
      >
        Entrar con Google
      </button>
    </form>
  );
}

export function LoginCard({ config, marcaSvg }: { config: PublicConfig; marcaSvg: string }) {
  return (
    <SessionProvider config={config}>
      <main className="flex min-h-screen items-center justify-center bg-bg px-4">
        <div className="w-full max-w-md rounded-tarjeta border border-line bg-raised p-8">
          <span className="marca" aria-hidden dangerouslySetInnerHTML={{ __html: marcaSvg }} />
          <h1 className="mt-6 text-2xl font-extrabold text-ink">Entra a IAxTi</h1>
          <p className="mb-6 mt-1 text-sm text-body">
            Sin contraseña: te mandamos un enlace a tu correo.
          </p>
          <Formulario />
        </div>
      </main>
    </SessionProvider>
  );
}
