import type { Config } from 'tailwindcss';

// Design tokens (Phase 12 Slice 1). The AUTHORITATIVE spec is
// refdoc/unifycoi-design-system.html; its :root lives in globals.css and is the single source
// of truth. These utilities map to those CSS vars so the design-system file stays editable in
// one place. "Lime + graphite ops theme" — Plus Jakarta Sans, warm canvas, large radii,
// soft layered shadows, lime brand highlight + graphite primary action.
//
// preflight is OFF: the design system is ADDITIVE this phase — Tailwind's global reset would
// restyle the un-retrofitted inline-styled tenant pages (they migrate in Slice 9). Primitives
// get box-sizing via a minimal base rule in globals.css instead.

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)' },
        border: { DEFAULT: 'var(--border)', strong: 'var(--border-strong)' },
        fg: { DEFAULT: 'var(--fg)', muted: 'var(--fg-muted)' },
        accent: { DEFAULT: 'var(--accent)', ink: 'var(--accent-ink)', soft: 'var(--accent-soft)' },
        action: 'var(--action)',
        info: { DEFAULT: 'var(--info)', ink: 'var(--info-ink)', soft: 'var(--info-soft)' },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        attention: { DEFAULT: 'var(--attention)', soft: 'var(--attention-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
      },
      fontFamily: {
        sans: ['var(--font-jakarta)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        panel: 'var(--radius-panel)',
        card: 'var(--radius-card)',
        ctl: 'var(--radius-ctl)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        raise: 'var(--shadow-raise)',
        ring: 'var(--ring)',
      },
    },
  },
  plugins: [],
};

export default config;
