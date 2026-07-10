// Shared inline styles for the /billing/setup route's files only — NOT a new app-wide design
// system. Same visual family as src/app/reset-password/styles.ts (which itself matches
// src/app/login/* and src/app/v/[token]/page.tsx) — duplicated per-route deliberately, matching
// that file's own precedent, rather than importing across route boundaries.

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
  maxWidth: 480,
  width: '100%',
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
};

export const centeredCard: CSSProperties = { ...card, textAlign: 'center' };

export const heading: CSSProperties = { fontSize: 20, fontWeight: 700, margin: '0 0 12px', color: '#111827' };
export const body: CSSProperties = { fontSize: 16, color: '#4b5563', lineHeight: '1.6', margin: 0 };
export const errorText: CSSProperties = { margin: '12px 0 0', color: '#cf222e', fontSize: 13 };
export const button = (busy: boolean): CSSProperties => ({
  padding: '10px 18px', borderRadius: 6, border: 'none', background: '#0969da', color: 'white',
  fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, marginTop: 16,
});
