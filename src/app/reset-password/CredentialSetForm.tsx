'use client';

// The valid-token form (Slice 4a). Copy branches on the target USER'S STATUS, not on token
// origin — status is the authoritative signal (an invited user has never set a credential;
// token-origin is just history, and the table carries no reset/invite discriminator).

import { useState } from 'react';
import { isPasswordValid, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy';
import * as s from './styles';

export function CredentialSetForm({
  token,
  userStatus,
  tenantName,
}: {
  token: string;
  userStatus: 'invited' | 'active';
  tenantName: string;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lengthOk = isPasswordValid(password);
  const matchOk = password === confirm;
  const inviteFlow = userStatus === 'invited';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!lengthOk || !matchOk) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? 'This link is no longer valid — refresh the page and try again.');
        setBusy(false);
        return;
      }
      window.location.assign(`/login?notice=${inviteFlow ? 'activated' : 'reset'}`);
    } catch {
      setError('Network error. Please try again.');
      setBusy(false);
    }
  }

  return (
    <main style={s.centeredPage}>
      <div style={s.card}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: '#111827' }}>
          {inviteFlow ? `Welcome to ${tenantName}` : 'Set a new password'}
        </h1>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#57606a' }}>
          {inviteFlow ? `Set a password to activate your account.` : 'Choose a new password for your account.'}
        </p>
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          <label style={s.label}>
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={s.input}
            />
          </label>
          <label style={s.label}>
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              style={s.input}
            />
          </label>
          {touched && !lengthOk && <p style={s.errorText}>Password must be at least {MIN_PASSWORD_LENGTH} characters.</p>}
          {touched && lengthOk && !matchOk && <p style={s.errorText}>Passwords don&rsquo;t match.</p>}
          {error && <p role="alert" style={s.errorText}>{error}</p>}
          <button type="submit" disabled={busy} style={s.button(busy)}>
            {busy ? 'Saving…' : inviteFlow ? 'Activate account' : 'Set password'}
          </button>
        </form>
      </div>
    </main>
  );
}
