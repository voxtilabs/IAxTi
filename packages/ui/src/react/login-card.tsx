'use client';

import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { SessionProvider, useSession, type PublicConfig } from './session';
import { ModeToggle } from './mode-toggle';
import { MARCA_LOCKUP_SVG } from './marca-svg';
import { useMarcaSvg } from './use-marca-svg';

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        fill="rgb(66, 133, 244)"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
      />
      <path
        fill="rgb(52, 168, 83)"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"
      />
      <path
        fill="rgb(251, 188, 5)"
        d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.16 0 9.98 0 12c0 2.02.45 3.84 1.25 5.42l4.03-3.15z"
      />
      <path
        fill="rgb(234, 67, 53)"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.93 6.72-4.93z"
      />
    </svg>
  );
}

const CAMPO =
  'h-control md:h-[56px] rounded-[14px] border border-border bg-white px-5 text-base text-ink placeholder:text-muted transition-all';

function Formulario({ recibeLosRedirects }: { recibeLosRedirects: boolean }) {
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
        {/* La instrucción cambia según el dominio (#113).

            Donde el enlace del correo SÍ aterriza —la app de clientes, que
            vive en el site_url— se ofrecen los dos caminos. Donde NO, decirle
            "abre el enlace" es mandarlo a la aplicación equivocada y dejarlo
            preguntándose por qué ve una bandeja de conversaciones en vez del
            panel. El código entra igual y no pisa ningún redirect. */}
        <p className="rounded-[16px] border border-action-soft-br bg-action-soft px-5 py-4 text-sm text-action-text">
          <span className="font-medium">Revisa tu correo ({email}).</span>{' '}
          {recibeLosRedirects
            ? 'Abre el enlace desde este mismo dispositivo, o escribe aquí el código de 6 dígitos si viene en el correo.'
            : 'Escribe aquí el código de 6 dígitos del correo. Acá se entra con el código, no con el enlace.'}
        </p>
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
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
          <p className="rounded-[16px] border border-bad-soft-br bg-bad-soft px-5 py-4 text-sm text-bad-text">
            <span className="font-medium">Ese código no sirvió.</span> Revisa que sea el último
            correo, o pide otro.
          </p>
        )}
        <button
          type="submit"
          disabled={codigo.length !== 6 || verificando}
          className="pulso-access-submit h-control md:h-[56px] rounded-full bg-action px-8 font-display text-base font-bold text-white hover:bg-action-hover disabled:opacity-50 transition-all cursor-pointer"
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
      <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
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
        <p className="rounded-[16px] border border-bad-soft-br bg-bad-soft px-5 py-4 text-sm text-bad-text">
          <span className="font-medium">No pudimos enviar el código.</span> Revisa el correo e
          intenta de nuevo en unos minutos.
        </p>
      )}

      <button
        type="submit"
        aria-label="Enviarme el acceso"
        className="pulso-access-submit h-control md:h-[56px] relative flex items-center justify-center rounded-full bg-action px-8 font-display text-base font-bold text-white hover:bg-action-hover transition-all cursor-pointer"
      >
        <span>Enviarme el acceso</span>
        <ArrowRight className="absolute right-6 h-5 w-5" aria-hidden="true" />
      </button>
      {recibeLosRedirects && (
        <button
          type="button"
          onClick={() => void conGoogle()}
          aria-label="Entrar con Google"
          className="h-control md:h-[56px] flex items-center justify-center gap-3 rounded-full border border-border bg-white px-8 text-base font-medium text-ink hover:bg-bg-raised transition-colors cursor-pointer"
        >
          <GoogleIcon className="h-5 w-5 flex-shrink-0" />
          <span>Continuar con Google</span>
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
   * ¿Los redirects de autenticación aterrizan en ESTE dominio? (#113)
   *
   * Es una sola pregunta porque las dos consecuencias tienen la misma causa:
   * GoTrue fuerza `redirect_to` al `site_url` aunque la URL pedida esté en la
   * allowlist. Donde eso no aplica —la app de clientes, que vive en el
   * site_url— todo funciona. En el panel de plataforma, no:
   *
   * - "Entrar con Google" dejaría al operador en la app de CLIENTES.
   * - Decirle "abre el enlace del correo" lo manda al mismo lugar, y se queda
   *   preguntándose por qué ve una bandeja en vez del panel.
   *
   * Con `false` desaparece el botón de Google y la instrucción dice lo único
   * que sí funciona: el código de 6 dígitos, que no pisa ningún redirect.
   *
   * Sobre Google en particular, la incertidumbre dicha con todas sus letras:
   * el comportamiento está reportado para el enlace mágico y no lo pude
   * comprobar para OAuth. Ofrecer un botón que quizás deja a alguien en la
   * app equivocada es peor que no ofrecerlo cuando hay otro camino que sí
   * sabemos que funciona.
   */
  recibeLosRedirects?: boolean;
}

function AccessOrbs() {
  return (
    <div className="pulso-access-orbs" aria-hidden="true">
      <picture>
        <source srcSet="/marca/iaxti-access-orbs.webp" type="image/webp" />
        <img
          src="/marca/iaxti-access-orbs.png"
          alt=""
          className="h-full w-full object-contain object-top-right pointer-events-none select-none"
          loading="eager"
          decoding="async"
        />
      </picture>
    </div>
  );
}

function Access3DArtwork() {
  return (
    <div className="pulso-access-bottom-jelly" aria-hidden="true">
      <picture>
        <source srcSet="/marca/iaxti-stage-artwork.webp" type="image/webp" />
        <img
          src="/marca/iaxti-stage-artwork.png"
          alt=""
          className="h-full w-full object-contain object-bottom-left pointer-events-none select-none"
          loading="eager"
          decoding="async"
        />
      </picture>
    </div>
  );
}

export function LoginCard({
  config,
  marcaSvg,
  titulo,
  subtitulo,
  recibeLosRedirects = true,
}: LoginCardProps) {
  const marcaCabecera = useMarcaSvg(marcaSvg);
  const marcaPie = useMarcaSvg(MARCA_LOCKUP_SVG);
  return (
    <SessionProvider config={config}>
      <div className="pulso-access">
        <div className="pulso-access-stage">
          <AccessOrbs />
          <Access3DArtwork />

          <header className="pulso-access-header">
            {/* Solo SVG versionado: web/app/login usa IAXTI_LOCKUP_SVG y admin/app/login
                MARCA_LOCKUP_SVG. useMarcaSvg solo renombra IDs; nunca recibe texto del usuario (#758). */}
            {/* nosemgrep: react-dangerouslysetinnerhtml */}
            <span
              className="marca"
              aria-label={titulo ? 'VoxTi Labs' : 'IAxTi'}
              dangerouslySetInnerHTML={{ __html: marcaCabecera }}
            />
            <ModeToggle />
          </header>
          <main className="pulso-access-main">
            <section className="pulso-access-story" aria-labelledby="acceso-historia">
              <div className="pulso-access-story-content">
                <span className="pulso-access-badge">CONECTA LO QUE IMPORTA</span>
                <h1 id="acceso-historia" className="pulso-access-title">
                  Todo empieza<br />con un <span>hola.</span>
                </h1>
                <div className="pulso-access-substory">
                  <p className="pulso-access-desc">
                    Conversaciones, clientes y equipo.<br />
                    Todo en un mismo lugar.
                  </p>
                  <div className="pulso-access-sequence" aria-label="Conversar, conocer y acompañar">
                    <span>Conversar</span>
                    <span className="pulso-dot" aria-hidden="true">·</span>
                    <span>Conocer</span>
                    <span className="pulso-dot" aria-hidden="true">·</span>
                    <span>Acompañar</span>
                  </div>
                </div>
              </div>
            </section>
            <section className="pulso-access-form-section" aria-labelledby="acceso-titulo">
              <div className="pulso-access-card">
                <h2 id="acceso-titulo">{titulo ?? 'Entra a IAxTi'}</h2>
                <p className="mt-2 text-sm text-body">
                  {subtitulo ?? 'Te enviamos un enlace a tu correo.'}
                </p>
                <Formulario recibeLosRedirects={recibeLosRedirects} />
              </div>
            </section>
          </main>
          <footer className="pulso-access-footer">
            {/* MARCA_LOCKUP_SVG es una constante versionada; solo cambian los IDs de instancia (#758). */}
            {/* nosemgrep: react-dangerouslysetinnerhtml */}
            <span
              className="marca"
              aria-label="VoxTi Labs"
              dangerouslySetInnerHTML={{ __html: marcaPie }}
            />
            <p>Hecho para los negocios que hacen de cada conversación una relación.</p>
          </footer>
        </div>
      </div>
    </SessionProvider>
  );
}
