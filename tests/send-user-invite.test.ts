// Slice 12/5b, Feature 2 — Send/Resend invite. sendUserInvite reuses issueInviteToken verbatim
// (the SAME path as the provisioning wizard's Admin invite and the billing-setup link) — this
// tests the wiring, not a new token system.

import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import { sendUserInvite } from '@/lib/services/users';
import { confirmPasswordReset } from '@/lib/services/password-reset';

describe('sendUserInvite', () => {
  let db: ReturnType<typeof setupTestDb>;
  let tenant: ReturnType<typeof seedTenant>;
  let admin: ReturnType<typeof seedTenantUser>;

  beforeEach(() => {
    db = setupTestDb();
    tenant = seedTenant(db);
    admin = seedTenantUser(db, tenant.id, { role: 'admin' });
  });
  afterEach(() => db.close());

  test('sends an invite to a dormant (invited) user: mints a token, sets invite_sent_at, returns a working link', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager', status: 'invited' });
    const before = db.prepare('SELECT invite_sent_at FROM users WHERE id = ?').get(target.id) as { invite_sent_at: string | null };
    expect(before.invite_sent_at).toBeNull();

    const result = sendUserInvite(db, tenant.id, target.id, admin.id);
    expect(result.inviteUrl).toContain('/reset-password?token=');
    expect(result.user.status).toBe('invited');

    const after = db.prepare('SELECT invite_sent_at FROM users WHERE id = ?').get(target.id) as { invite_sent_at: string | null };
    expect(after.invite_sent_at).toBeTruthy();

    const rawToken = result.inviteUrl.split('token=')[1];
    expect(confirmPasswordReset(db, { rawToken, newPassword: 'a-fresh-password-1' }).ok).toBe(true);
  });

  test('does NOT queue a notification — the link is surfaced directly, same as the Admin invite', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager', status: 'invited' });
    sendUserInvite(db, tenant.id, target.id, admin.id);
    const count = (db.prepare('SELECT COUNT(*) c FROM notifications').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test('logs a user.invite_sent audit event', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager', status: 'invited' });
    sendUserInvite(db, tenant.id, target.id, admin.id);
    const event = db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND event_type = 'user.invite_sent' AND target_id = ?").get(tenant.id, target.id);
    expect(event).toBeTruthy();
  });

  test('resend: issues a SECOND, independently-usable token; sets invite_sent_at again', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager', status: 'invited' });
    const t0 = new Date();
    const first = sendUserInvite(db, tenant.id, target.id, admin.id, t0);
    const firstSentAt = (db.prepare('SELECT invite_sent_at FROM users WHERE id = ?').get(target.id) as { invite_sent_at: string }).invite_sent_at;

    const second = sendUserInvite(db, tenant.id, target.id, admin.id, new Date(t0.getTime() + 1000));
    expect(second.inviteUrl).not.toBe(first.inviteUrl);

    const secondSentAt = (db.prepare('SELECT invite_sent_at FROM users WHERE id = ?').get(target.id) as { invite_sent_at: string }).invite_sent_at;
    expect(secondSentAt).not.toBe(firstSentAt); // re-stamped, not left at the first send's time

    // Deliberate: resend does NOT invalidate the first link. Both remain individually usable
    // (same shape as the Admin invite / billing-setup precedent) — but using either one
    // invalidates the other, so there is never more than one *usable* outcome.
    const tokenRowCount = (db.prepare('SELECT COUNT(*) c FROM password_reset_tokens WHERE user_id = ?').get(target.id) as { c: number }).c;
    expect(tokenRowCount).toBe(2);

    const firstToken = first.inviteUrl.split('token=')[1];
    expect(confirmPasswordReset(db, { rawToken: firstToken, newPassword: 'first-wins-pass-1' }).ok).toBe(true);

    // The second (still-outstanding) token is now invalidated by the first one's use.
    const secondToken = second.inviteUrl.split('token=')[1];
    expect(confirmPasswordReset(db, { rawToken: secondToken, newPassword: 'should-fail-pass-1' })).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('rejects sending to an already-active user (409) — re-inviting an active user is not this operation', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager', status: 'active', password: 'existing-pass-1' });
    expect(() => sendUserInvite(db, tenant.id, target.id, admin.id)).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('rejects sending to a disabled user (409)', () => {
    const target = seedTenantUser(db, tenant.id, { role: 'store_manager', status: 'disabled' });
    expect(() => sendUserInvite(db, tenant.id, target.id, admin.id)).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('unknown user is a 404', () => {
    expect(() => sendUserInvite(db, tenant.id, 'no-such-user', admin.id)).toThrow(expect.objectContaining({ status: 404 }));
  });
});
