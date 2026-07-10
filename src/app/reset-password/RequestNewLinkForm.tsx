'use client';

// Small inline "email me a new link" form for the expired+active-user dead end (Slice 4a).
// Wires directly to the already-built, already-tested, enumeration-safe request-reset endpoint
// (Phase 11 / SEC-8) — no new backend surface, just its first UI consumer. (The expired+invited
// case does NOT get this: there is no self-serve invite reissue until the Slice 6 cockpit, so
// that path stays a plain "contact whoever sent your invite" message with no button.)

import { useState } from 'react';
import * as s from './styles';

export function RequestNewLinkForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Enumeration-safe: show the same confirmation even on a network hiccup — never let the
      // failure mode hint at whether the email resolved.
    } finally {
      setSent(true);
      setBusy(false);
    }
  }

  if (sent) {
    return <p style={s.successText}>If an account exists for that email, a new link has been sent.</p>;
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10, marginTop: 16, textAlign: 'left' }}>
      <label style={s.label}>
        Email
        <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={s.input} />
      </label>
      <button type="submit" disabled={busy} style={s.button(busy)}>
        {busy ? 'Sending…' : 'Email me a new link'}
      </button>
    </form>
  );
}
