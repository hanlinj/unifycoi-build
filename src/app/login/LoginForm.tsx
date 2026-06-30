'use client';

import { useState } from 'react';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? 'Invalid email or password.' : 'Sign-in failed. Please try again.');
        setBusy(false);
        return;
      }
      // Cookie is set by the response; full navigation so the root route reads it and lands by role.
      window.location.assign('/');
    } catch {
      setError('Network error. Please try again.');
      setBusy(false);
    }
  }

  const input: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 14, marginTop: 4 };
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      <label style={{ fontSize: 13, fontWeight: 600 }}>
        Email
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} style={input} />
      </label>
      <label style={{ fontSize: 13, fontWeight: 600 }}>
        Password
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={input} />
      </label>
      {error && <p role="alert" style={{ margin: 0, color: '#cf222e', fontSize: 13 }}>{error}</p>}
      <button type="submit" disabled={busy} style={{ padding: '9px 16px', borderRadius: 6, border: 'none', background: '#0969da', color: 'white', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
