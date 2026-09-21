'use client';

import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { SessionProvider, useSession, type PublicConfig } from './session';
import { MarcaJelly } from './marca-jelly';
import { ModeToggle } from './mode-toggle';
import { MARCA_LOCKUP_SVG } from './marca-svg';

const CAMPO =
  'h-control rounded-campo border border-line-strong bg-field px-4 text-base text-ink placeholder:text-faint';

function Formulario({ conGoogle: ofreceGoogle }: { conGoogle: boolean }) {
  const { supabase } = useSession();
  const [email, setEmail] = useState('');
  const [codigo, setCodigo] = useState('');
  const [estado, setEstado] = useState<'inicial' | 'enviado' | 'error' | 'codigo-malo'>('inicial');
  const [verificando, setVerificando] = useState(false);

  async function enviarCodigo(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setEstado(error ? 'error' : 'enviado');
  }

  // El CÓDIGO entra siempre, sin importar redirects (issue 113: GoTrue
  // fuerza los enlaces al site_url — con verifyOtp ese camino ni se pisa).
  async function entrarConCodigo(e: FormEvent) {
    e.preventDefault();
    if (verificando) return;
    setVerificando(true);
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: codigo.trim(),
      type: 'email',
    });
    setVerificando(false);
    if (error) {
      setEstado('codigo-malo');
      return;
    }
    window.location.href = '/';
  }

  async function conGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }

  if (estado === 'enviado' || estado === 'codigo-malo') {
    return (
      <form onSubmit={entrarConCodigo} className="flex flex-col gap-4">
        <p className="rounded-campo border border-action-soft-br bg-action-soft px-5 py-4 text-sm text-action-text">
          <span className="font-medium">Revisa tu correo ({email}).</span> Abre el enlace desde
          este mismo dispositivo, o escribe aquí el código de 6 dígitos si viene en el correo.
        </p>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Código
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            minLength={6}
            maxLength={6}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            className={`${CAMPO} dato text-center text-2xl tracking-[0.4em]`}
            autoFocus
          />
        </label>
        {estado === 'codigo-malo' && (
          <p className="rounded-campo border border-bad-soft-br bg-bad-soft px-5 py-4 text-sm text-bad-text">
            <span className="font-medium">Ese código no sirvió.</span> Revisa que sea el último
            correo, o pide otro.
          </p>
        )}
        <button
          type="submit"
          disabled={codigo.length !== 6 || verificando}
          className="h-control rounded-boton bg-action px-8 font-display text-base font-bold text-white hover:bg-action-hover disabled:opacity-50"
        >
          {verificando ? 'Entrando…' : 'Entrar'}
        </button>
        <button
          type="button"
          onClick={() => {
            setCodigo('');
            setEstado('inicial');
          }}
          className="text-sm text-muted"
        >
          Pedir otro código
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={enviarCodigo} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Tu correo
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="duena@tunegocio.cl"
          className={CAMPO}
        />
      </label>

      {estado === 'error' && (
        <p className="rounded-campo border border-bad-soft-br bg-bad-soft px-5 py-4 text-sm text-bad-text">
          <span className="font-medium">No pudimos enviar el código.</span> Revisa el correo e
          intenta de nuevo en unos minutos.
        </p>
      )}

      <button
        type="submit"
        className="h-control rounded-boton bg-action px-8 font-display text-base font-bold text-white hover:bg-action-hover"
      >
        Enviarme el acceso
      </button>
      {ofreceGoogle && (
        <button
          type="button"
          onClick={() => void conGoogle()}
          className="h-control rounded-boton border border-line-strong px-8 text-base text-ink"
        >
          Entrar con Google
        </button>
      )}
    </form>
  );
}

export interface LoginCardProps {
  config: PublicConfig;
  marcaSvg: string;
  titulo?: string;
  subtitulo?: string;
  /**
   * Si se ofrece "Entrar con Google". Por defecto sí, que es lo correcto en
   * la app de clientes: vive en el `site_url`, así que el redirect vuelve a
   * donde tiene que volver.
   *
   * En el panel de plataforma va APAGADO. GoTrue fuerza `redirect_to` al
   * `site_url` aunque la URL pedida esté en la allowlist (#113), así que el
   * operador que entra por Google desde admin aterriza en la app de
   * CLIENTES. El código de 6 dígitos no pisa ese camino y funciona igual.
   *
   * Es una decisión bajo incertidumbre, dicha con todas sus letras: el
   * comportamiento está reportado para el enlace mágico y no lo pude
   * comprobar para OAuth con staging caído. Ofrecer un botón que quizás deja
   * a alguien en la app equivocada es peor que no ofrecerlo, sobre todo
   * cuando hay otro camino que sí sabemos que funciona.
   */
  conGoogle?: boolean;
}

export function LoginCard({ config, marcaSvg, titulo, subtitulo, conGoogle = true }: LoginCardProps) {
  return (
    <SessionProvider config={config}>
      <div className="pulso-access">
        <div className="pulso-access-stage">
          <header className="pulso-access-header">
            <span className="marca" aria-label={titulo ? 'VoxTi Labs' : 'IAxTi'} dangerouslySetInnerHTML={{ __html: marcaSvg }} />
            <ModeToggle />
          </header>
          <main className="pulso-access-main">
            <section className="pulso-access-story" aria-labelledby="acceso-historia">
              <div className="pulso-access-object" aria-hidden="true">
                <MarcaJelly />
                <p>Conecta lo que importa</p>
              </div>
              <span className="pulso-eyebrow">Tu negocio, en conversación</span>
              <h1 id="acceso-historia">Todo empieza<br />con un <span>hola.</span></h1>
              <p>Conversaciones, clientes y equipo. Dale continuidad a cada relación desde un mismo lugar.</p>
              <div className="pulso-access-sequence" aria-label="Conversar, conocer y acompañar">
                <span><b>01</b> Conversar</span>
                <span><b>02</b> Conocer</span>
                <span><b>03</b> Acompañar</span>
              </div>
            </section>
            <section aria-labelledby="acceso-titulo">
              <div className="pulso-access-card">
                <span className="pulso-access-key" aria-hidden="true"><KeyRound size={22} /></span>
                <h2 id="acceso-titulo">{titulo ?? 'Entra a IAxTi'}</h2>
                <p className="mt-3 text-sm text-body">
                  {subtitulo ?? 'Sin contraseña: te mandamos el acceso a tu correo.'}
                </p>
                <Formulario conGoogle={conGoogle} />
              </div>
              <p className="pulso-access-note">Tu equipo. Tu contexto. Tu forma de atender.</p>
            </section>
          </main>
          <footer className="pulso-access-footer">
            <span className="marca" aria-label="VoxTi Labs" dangerouslySetInnerHTML={{ __html: MARCA_LOCKUP_SVG }} />
            <p>Hecho para los negocios que hacen de cada conversación una relación.</p>
          </footer>
        </div>
      </div>
    </SessionProvider>
  );
}
