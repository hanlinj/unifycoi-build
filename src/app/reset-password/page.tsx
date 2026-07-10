// /reset-password — the credential-set landing page (Slice 4a). Closes the loop for BOTH the
// wizard's invite link (Slice 4) and the pre-existing password-reset request flow (Phase 11) —
// one page, branching on the target user's STATUS (not on token origin: the token table has no
// reset/invite discriminator and isn't getting one — status is the more correct signal).
//
// Server component: peeks the token server-side (peekResetToken, direct service call — no
// self-fetch, same convention as the fleet/provisioning pages) so the right state renders on
// first paint, never flashing a password field for a dead token.

import { getDb } from '@/lib/db/client';
import { peekResetToken, type TokenPeek } from '@/lib/services/password-reset';
import { CredentialSetForm } from './CredentialSetForm';
import { RequestNewLinkForm } from './RequestNewLinkForm';
import * as s from './styles';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({ searchParams }: { searchParams: { token?: string } }) {
  const token = searchParams.token;
  const peek: TokenPeek = token ? await peekResetToken(getDb(), token) : { status: 'invalid' };

  if (peek.status === 'invalid') {
    return (
      <DeadEnd icon="⚠️" title="This link isn&rsquo;t valid">
        Double-check the link you used, or ask whoever sent it for a fresh one.
      </DeadEnd>
    );
  }

  if (peek.status === 'consumed') {
    return (
      <DeadEnd icon="✓" title="This link has already been used">
        This link has already been used to set a password.{' '}
        <a href="/login" style={{ color: '#0969da', fontWeight: 600 }}>Sign in instead</a>.
      </DeadEnd>
    );
  }

  if (peek.status === 'expired') {
    if (peek.userStatus === 'invited') {
      // No self-serve invite reissue until the Slice 6 cockpit — don't offer a button that
      // goes nowhere; the only real next step today is asking the sender for a new one.
      return (
        <DeadEnd icon="⏱️" title="This link has expired">
          This invite link is no longer valid. Contact whoever sent your invite and ask them to send a new one.
        </DeadEnd>
      );
    }
    // Ordinary reset case — the request-reset endpoint already exists and is safe to expose;
    // this is its first UI consumer.
    return (
      <main style={s.centeredPage}>
        <div style={s.centeredCard}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⏱️</div>
          <h1 style={s.heading}>This link has expired</h1>
          <p style={s.body}>Request a new password-reset link below.</p>
          <RequestNewLinkForm />
        </div>
      </main>
    );
  }

  // valid
  return (
    <CredentialSetForm
      token={token as string}
      userStatus={peek.userStatus === 'invited' ? 'invited' : 'active'}
      tenantName={peek.tenantName ?? 'your organization'}
    />
  );
}

function DeadEnd({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <main style={s.centeredPage}>
      <div style={s.centeredCard}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>{icon}</div>
        <h1 style={s.heading}>{title}</h1>
        <p style={s.body}>{children}</p>
      </div>
    </main>
  );
}
