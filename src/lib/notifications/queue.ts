// Notification queue helpers — the single place rows enter the notifications table, so
// every producer (exception events, the renewal ladder, the digest) writes consistent rows.
// The worker (Slice C) is the consumer.
//
// Tiers (Notifications_and_Communications.md): kind='exception' = immediate (scheduled_for
// null → next worker tick); kind='digest' = routine, batched by the daily digest builder.
//
// Phase 13 migration, Stage 3: converted as a hard dependency of password-reset.ts's
// requestPasswordReset (the rest of the notifications module — worker/digest/renewal/chase —
// stays synchronous/SQLite-typed until its own later stage).

import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';

export interface QueueNotificationInput {
  recipientType: 'user' | 'vendor';
  recipientRef: string;            // user_id, or vendor email
  kind: 'exception' | 'digest';
  payload: Record<string, unknown>;
  scheduledFor?: string | null;    // ISO; null = send asap (immediate)
  documentId?: string | null;      // the COI a renewal reminder chases (for supersession)
}

/** Insert one notification row (status='queued'). Returns its id. */
export async function queueNotification(
  db: Db,
  tenantId: string,
  input: QueueNotificationInput
): Promise<string> {
  const tdb = new TenantDB(db, tenantId);
  const id = randomUUID();
  await tdb.insert('notifications', {
    id,
    recipient_type: input.recipientType,
    recipient_ref: input.recipientRef,
    channel: 'email',
    kind: input.kind,
    status: 'queued',
    scheduled_for: input.scheduledFor ?? null,
    sent_at: null,
    payload_json: JSON.stringify(input.payload),
    document_id: input.documentId ?? null,
    claimed_at: null,
    created_at: new Date(),
  });
  return id;
}

/**
 * Queue an exception (immediate) notification to every active Admin of the tenant.
 * Admin scope is org-wide (Roles_and_Permissions.md), so org-level exceptions
 * (a decline, a rule-change non-compliance) reach all admins. Returns the ids created.
 */
export async function notifyTenantAdmins(
  db: Db,
  tenantId: string,
  payload: Record<string, unknown>
): Promise<string[]> {
  const tdb = new TenantDB(db, tenantId);
  const admins = await tdb.all<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND status != 'disabled'`
  );
  // Stage 0's catalogued N+1-in-.map() finding: can't await inside .map(), and queueNotification
  // is now async — Promise.all + an async mapper instead of the old synchronous .map().
  return Promise.all(
    admins.map((a) =>
      queueNotification(db, tenantId, {
        recipientType: 'user',
        recipientRef: a.id,
        kind: 'exception',
        payload,
      })
    )
  );
}

/** Operator (tenant) display name for vendor-facing From branding. */
export async function getOperatorName(db: Db, tenantId: string): Promise<string | null> {
  const row = await db.selectFrom('tenants').select('name').where('id', '=', tenantId).executeTakeFirst();
  return row?.name ?? null;
}
