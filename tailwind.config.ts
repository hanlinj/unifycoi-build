import type { Config } from 'tailwindcss';

// Design tokens (Phase 12 Slice 1, restored — ADR-012-11 reverses ADR-012-01's lime + graphite
// theme). The AUTHORITATIVE spec is refdoc/unifycoi-design-system.html; its :root lives in
// globals.css and is the single source of truth. These utilities map to those CSS vars so the
// design-system file stays editable in one place. Palette: Slice 1's original Primer-family
// blue (#0969da) — clean, light, trustworthy B2B ops direction. `action`/`info` are kept as
// color keys (aliased to `accent` at the CSS-var layer) so existing call sites don't need
// touching — there's only ONE accent color now, not three. Polish pass: Manrope (self-hosted
// via next/font) replaces the system-ui stack; `border.control` + `ring-soft` are a softer
// pair used only by form inputs, distinct from the crisper `border.strong`/`ring` buttons and
// keyboard-focus elsewhere still use.
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
        border: { DEFAULT: 'var(--border)', strong: 'var(--border-strong)', control: 'var(--border-control)' },
        fg: { DEFAULT: 'var(--fg)', muted: 'var(--fg-muted)' },
        accent: { DEFAULT: 'var(--accent)', emphasis: 'var(--accent-emphasis)', ink: 'var(--accent-ink)', soft: 'var(--accent-soft)' },
        action: 'var(--action)',
        info: { DEFAULT: 'var(--info)', ink: 'var(--info-ink)', soft: 'var(--info-soft)' },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        attention: { DEFAULT: 'var(--attention)', soft: 'var(--attention-soft)' },
        danger: { DEFAULT: 'var(--danger)', emphasis: 'var(--danger-emphasis)', soft: 'var(--danger-soft)' },
      },
      fontFamily: {
        sans: ['var(--font-manrope)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      borderRadius: {
        panel: 'var(--radius-panel)',
        card: 'var(--radius-card)',
        ctl: 'var(--radius-ctl)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        overlay: 'var(--shadow-overlay)',
        ring: 'var(--ring)',
        'ring-soft': 'var(--ring-soft)',
      },
    },
  },
  plugins: [],
};

export default config;
