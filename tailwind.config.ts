import type { Config } from 'tailwindcss';

// Design tokens (Phase 12 Slice 1). One source of truth for the palette that was previously
// hand-repeated as inline hex across every surface. Direction: clean, light, trustworthy B2B
// ops dashboard (refs: the self-storage ops screenshots + Cubby), Primer-family palette —
// an evolution of what the app already used, not a rip-out.
//
// preflight is OFF: the design system is ADDITIVE this phase. Turning on Tailwind's global
// reset would restyle the un-retrofitted inline-styled tenant pages; they migrate in Slice 9.
// Primitives get correct box-sizing via a minimal base rule in globals.css instead.

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        canvas: '#ffffff',
        surface: '#f6f8fa',
        'surface-hover': '#eef1f4',
        border: '#d0d7de',
        'border-muted': '#eaeef2',
        fg: '#1f2328',
        'fg-muted': '#57606a',
        'fg-subtle': '#6e7781',
        accent: { DEFAULT: '#0969da', emphasis: '#0550ae', subtle: '#ddf4ff', fg: '#0969da' },
        success: { DEFAULT: '#1f883d', emphasis: '#1a7f37', subtle: '#dafbe1', fg: '#1a7f37' },
        attention: { DEFAULT: '#bf8700', emphasis: '#9a6700', subtle: '#fff8c5', fg: '#9a6700' },
        danger: { DEFAULT: '#cf222e', emphasis: '#a40e26', subtle: '#ffebe9', fg: '#cf222e' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      borderRadius: { card: '0.5rem' },
      boxShadow: {
        card: '0 1px 0 rgba(27,31,36,0.04)',
        overlay: '0 8px 24px rgba(27,31,36,0.20)',
      },
    },
  },
  plugins: [],
};

export default config;
