// Checkpoint (Slice 12/5b) — the full arc the brief asked to be proven end-to-end: a manager
// created by bulk import (Feature 1, dormant/invited/no-password) gets sent a real invite link
// (Feature 2), and that link actually drives the user through to an active login — not just
// each half tested in isolation. Confirms the invited->active flip (which already existed,
// generic over any 'invited' user) genuinely holds for an IMPORT-created manager specifically,
// not just admin-provisioned ones.

import { setupTestDb, seedTenant, seedTenantUser } from './helpers';
import { bulkCreateLocationsWithManagers } from '@/lib/services/bulk-onboarding';
import { sendUserInvite } from '@/lib/services/users';
import { peekResetToken, confirmPasswordReset } from '@/lib/services/password-reset';
import { loginResolvingTenant } from '@/lib/services/auth';
import { emptyImportRow, type ImportLocationRow } from '@/lib/import/location-rows';

function row(overrides: Partial<ImportLocationRow>): ImportLocationRow {
  return { ...emptyImportRow(), ...overrides };
}

test('bulk-imported manager: upload -> dormant manager created -> send invite -> lands valid+invited -> sets password -> active -> can log in', () => {
  const db = setupTestDb();
  const tenant = seedTenant(db);
  const admin = seedTenantUser(db, tenant.id, { role: 'admin' });

  // 1. Bulk import creates the location + a dormant manager (Feature 1).
  const importResult = bulkCreateLocationsWithManagers(
    db,
    tenant.id,
    [row({ storeName: 'Coeur d’Alene', address: '1 Main St', managerFirstName: 'Priya', managerLastName: 'Singh', managerEmail: 'priya@acme.test' })],
    admin.id
  );
  const managerId = importResult.managerUserIds[0];
  expect(managerId).toBeTruthy();

  const dormant = db.prepare('SELECT status, password_hash, invite_sent_at FROM users WHERE id = ?').get(managerId) as {
    status: string; password_hash: string | null; invite_sent_at: string | null;
  };
  expect(dormant.status).toBe('invited');
  expect(dormant.password_hash).toBeNull();
  expect(dormant.invite_sent_at).toBeNull(); // created dormant — nothing sent yet

  // 2. Admin sends the invite from the Users panel (Feature 2).
  const { inviteUrl } = sendUserInvite(db, tenant.id, managerId, admin.id);
  const rawToken = inviteUrl.split('token=')[1];

  const sentRow = db.prepare('SELECT invite_sent_at FROM users WHERE id = ?').get(managerId) as { invite_sent_at: string | null };
  expect(sentRow.invite_sent_at).toBeTruthy();

  // 3. The /reset-password landing page's read-only pre-check sees a valid, invited token —
  //    same peekResetToken every reset/invite link uses, no import-specific branch.
  const peek = peekResetToken(db, rawToken);
  expect(peek).toMatchObject({ status: 'valid', userId: managerId, tenantId: tenant.id, userStatus: 'invited' });

  // 4. The manager sets their password — confirmPasswordReset flips invited -> active.
  const confirm = confirmPasswordReset(db, { rawToken, newPassword: 'priyas-new-password-1' });
  expect(confirm).toEqual({ ok: true, userId: managerId, tenantId: tenant.id });

  const active = db.prepare('SELECT status, password_hash FROM users WHERE id = ?').get(managerId) as { status: string; password_hash: string | null };
  expect(active.status).toBe('active');
  expect(active.password_hash).toBeTruthy();

  // 5. And the login path — untouched by any of this — resolves them as a normal active user.
  const loginResult = loginResolvingTenant(db, 'priya@acme.test', 'priyas-new-password-1');
  expect(loginResult).not.toBeNull();
});
