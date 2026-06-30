'use client';

import { useState } from 'react';

export function SendReminderButton({ locationId, vendorId }: { locationId: string; vendorId: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  async function send() {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try {
      const res = await fetch(`/api/locations/${locationId}/send-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorId }),
      });
      setState(res.ok ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  }
  if (state === 'sent') return <span style={{ fontSize: 12, color: '#1a7f37', fontWeight: 600 }}>✓ Sent</span>;
  return (
    <button
      onClick={send}
      disabled={state === 'sending'}
      style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #d0d7de', background: state === 'error' ? '#ffebe9' : 'white', color: state === 'error' ? '#cf222e' : '#24292f', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
    >
      {state === 'sending' ? 'Sending…' : state === 'error' ? 'Retry' : 'Send reminder'}
    </button>
  );
}

export function ArchiveLocationButton({ locationId, locationName }: { locationId: string; locationName: string }) {
  const [state, setState] = useState<'idle' | 'archiving' | 'archived' | 'error'>('idle');
  async function archive() {
    if (state !== 'idle' && state !== 'error') return;
    const ok = window.confirm(
      `Archive “${locationName}”?\n\nArchived locations can't be hired against and won't accept new vendors. Vendors currently at this location are unaffected. This does not delete anything.`
    );
    if (!ok) return;
    setState('archiving');
    try {
      const res = await fetch(`/api/locations/${locationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      if (res.ok) { setState('archived'); window.location.reload(); }
      else setState('error');
    } catch {
      setState('error');
    }
  }
  if (state === 'archived') return <span style={{ fontSize: 13, color: '#57606a' }}>Archived</span>;
  return (
    <button
      onClick={archive}
      disabled={state === 'archiving'}
      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #cf222e', background: 'white', color: '#cf222e', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
    >
      {state === 'archiving' ? 'Archiving…' : state === 'error' ? 'Retry archive' : 'Archive location'}
    </button>
  );
}
