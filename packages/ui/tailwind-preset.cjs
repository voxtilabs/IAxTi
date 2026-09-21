/*
 * Preset de Tailwind del sistema Pulso (documento §11 + §4).
 * Las clases (`bg-raised`, `text-muted`) funcionan igual en los dos modos
 * sin variantes `dark:` — PROHIBIDAS en componentes.
 */
module.exports = {
  darkMode: ['selector', '[data-mode="noche"]'],
  theme: {
    extend: {
      colors: {
        // --- Los nombres de shadcn, atados a Pulso por shadcn-puente.css.
        //
        // Están acá para que un componente traído con `npx shadcn add` use
        // `bg-background` o `text-muted-foreground` y funcione sin retocarlo
        // (#291). NO son nombres para escribir a mano: en código nuestro se
        // usan los de abajo, que son los del documento de marca.
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        input: 'var(--input)',
        ring: 'var(--ring)',
        focus: 'var(--focus)',
        sidebar: {
          DEFAULT: 'var(--sidebar-background)',
          foreground: 'var(--sidebar-foreground)',
          primary: {
            DEFAULT: 'var(--sidebar-primary)',
            foreground: 'var(--sidebar-primary-foreground)',
          },
          accent: {
            DEFAULT: 'var(--sidebar-accent)',
            foreground: 'var(--sidebar-accent-foreground)',
          },
          border: 'var(--sidebar-border)',
          ring: 'var(--sidebar-ring)',
        },

        // --- Los de Pulso, que son los que se escriben.
        bg: 'var(--bg)',
        raised: 'var(--bg-raised)',
        rest: 'var(--bg-rest)',
        line: 'var(--border)',
        'line-strong': 'var(--border-strong)',
        ink: 'var(--text)',
        body: 'var(--text-body)',
        muted: {
          // OJO: en Pulso `text-muted` es TEXTO secundario y en shadcn
          // `bg-muted` es una SUPERFICIE. Conviven: el DEFAULT sigue siendo
          // el de Pulso —que es el que usa todo el código— y la superficie
          // queda como `muted-surface` para lo que venga del registro.
          DEFAULT: 'var(--text-muted)',
          surface: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        faint: 'var(--text-faint)',
        field: 'var(--field-bg)',
        action: {
          DEFAULT: 'var(--action)',
          hover: 'var(--action-hover)',
          contrast: 'var(--on-action)',
          text: 'var(--action-text)',
          soft: 'var(--action-soft)',
          'soft-br': 'var(--action-soft-br)',
        },
        warn: {
          DEFAULT: 'var(--warn)',
          text: 'var(--warn-text)',
          soft: 'var(--warn-soft)',
          'soft-br': 'var(--warn-soft-br)',
        },
        good: {
          text: 'var(--good-text)',
          soft: 'var(--good-soft)',
          'soft-br': 'var(--good-soft-br)',
        },
        bad: {
          DEFAULT: 'var(--bad)',
          text: 'var(--bad-text)',
          soft: 'var(--bad-soft)',
          'soft-br': 'var(--bad-soft-br)',
        },
      },
      // Radios de Pulso (§4): botón 999 · campo 14 · tarjeta 22 · bloque 28.
      borderRadius: {
        boton: '999px',
        campo: '14px',
        tarjeta: '22px',
        bloque: '28px',
      },
      // Escala de espaciado (§4): 8 · 16 · 24 · 32 · 48 · 64 · 96.
      spacing: {
        control: '46px', // alto mínimo de control
        'fila-x': 'var(--fila-x)',
        'fila-y': 'var(--fila-y)',
        'fila-gap': 'var(--fila-gap)',
      },
      fontSize: {
        titulo: ['clamp(1.75rem, 2.6vw, 2.4rem)', { lineHeight: '1.2', fontWeight: '800' }],
        seccion: ['1.125rem', { lineHeight: '1.4', fontWeight: '700' }],
        cuerpo: ['1rem', { lineHeight: '1.6' }],
        dato: ['0.875rem', { lineHeight: '1.4' }],
        rotulo: ['0.75rem', { lineHeight: '1.4' }],
      },
      fontFamily: {
        display: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      maxWidth: {
        contenido: '1120px',
      },
      // Dos sombras y ninguna más. `boxShadow` ya existía acá: agregar un
      // segundo bloque con el mismo nombre en `extend` no da error, la
      // segunda clave gana y la primera desaparece en silencio.
      boxShadow: {
        none: 'none',
        // El anillo de foco (Pulso §10).
        foco: '0 0 0 3px var(--action-soft)',
        // La única elevación (ADR-0018, #294): lo que se superpone al
        // contenido y se puede cerrar. Si aparece `shadow-lg` en un diff,
        // viene del registro de shadcn y hay que sacarla.
        flotante: 'var(--elevacion-flotante)',
      },
    },
  },
};
