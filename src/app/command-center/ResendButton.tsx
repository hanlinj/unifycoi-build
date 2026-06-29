'use client';

import { useState } from 'react';

export function ResendButton({ vendorId }: { vendorId: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function resend() {
    // Guard against double-fire: ignore clicks while a send is in flight or already succeeded
    // (avoids queueing two invite emails seconds apart). Errors may be retried.
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try {
      const res = await fetch(`/api/vendors/${vendorId}/resend-invite`, { method: 'POST' });
      setState(res.ok ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') return <span style={{ fontSize: 12, color: '#1a7f37', fontWeight: 600 }}>✓ Resent</span>;

  return (
    <button
      onClick={resend}
      disabled={state === 'sending'}
      style={{
        padding: '4px 12px',
        borderRadius: 6,
        border: '1px solid #d0d7de',
        background: state === 'error' ? '#ffebe9' : 'white',
        color: state === 'error' ? '#cf222e' : '#24292f',
        fontSize: 12,
        fontWeight: 600,
        cursor: state === 'sending' ? 'default' : 'pointer',
      }}
    >
      {state === 'sending' ? 'Resending…' : state === 'error' ? 'Retry' : 'Resend invite'}
    </button>
  );
}
