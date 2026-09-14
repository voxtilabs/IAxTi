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
        bg: 'var(--bg)',
        raised: 'var(--bg-raised)',
        rest: 'var(--bg-rest)',
        line: 'var(--border)',
        'line-strong': 'var(--border-strong)',
        ink: 'var(--text)',
        body: 'var(--text-body)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-faint)',
        field: 'var(--field-bg)',
        action: {
          DEFAULT: 'var(--action)',
          hover: 'var(--action-hover)',
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
      },
      fontFamily: {
        display: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      maxWidth: {
        contenido: '1000px',
      },
      // Sin sombras: Pulso las prohíbe salvo el anillo de foco (§10).
      boxShadow: {
        none: 'none',
        foco: '0 0 0 3px var(--action-soft)',
      },
    },
  },
};
