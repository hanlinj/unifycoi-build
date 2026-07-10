// Shared inline styles for the /reset-password route's files only (page + its two client
// forms) — NOT a new app-wide design system. Values match the existing pre-login visual family
// (src/app/login/*, src/app/v/[token]/page.tsx), which predates the Phase 12 platform
// design-system components and uses ad hoc inline styles throughout.

import type { CSSProperties } from 'react';

export const centeredPage: CSSProperties = {
  minHeight: '100vh',
  background: '#f9fafb',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

export const card: CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: '32px 24px',
  maxWidth: 400,
  width: '100%',
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
};

export const centeredCard: CSSProperties = { ...card, maxWidth: 480, textAlign: 'center' };

export const heading: CSSProperties = { fontSize: 20, fontWeight: 700, margin: '0 0 12px', color: '#111827' };

export const body: CSSProperties = { fontSize: 16, color: '#4b5563', lineHeight: '1.6', margin: 0 };

export const label: CSSProperties = { fontSize: 13, fontWeight: 600, display: 'block' };

export const input: CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 14, marginTop: 4, boxSizing: 'border-box' };

export const button = (busy: boolean): CSSProperties => ({
  padding: '9px 16px', borderRadius: 6, border: 'none', background: '#0969da', color: 'white',
  fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1,
});

export const errorText: CSSProperties = { margin: 0, color: '#cf222e', fontSize: 13 };
export const successText: CSSProperties = { margin: 0, color: '#1a7f37', fontSize: 13, fontWeight: 600 };
