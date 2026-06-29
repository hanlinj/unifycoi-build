// Notification queue helpers — the single place rows enter the notifications table, so
// every producer (exception events, the renewal ladder, the digest) writes consistent rows.
// The worker (Slice C) is the consumer.
//
// Tiers (Notifications_and_Communications.md): kind='exception' = immediate (scheduled_for
// null → next worker tick); kind='digest' = routine, batched by the daily digest builder.

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';

export interface QueueNotificationInput {
  recipientType: 'user' | 'vendor';
  recipientRef: string;            // user_id, or vendor email
  kind: 'exception' | 'digest';
  payload: Record<string, unknown>;
  scheduledFor?: string | null;    // ISO; null = send asap (immediate)
}

/** Insert one notification row (status='queued'). Returns its id. */
export function queueNotification(
  db: Database.Database,
  tenantId: string,
  input: QueueNotificationInput
): string {
  const tdb = new TenantDB(db, tenantId);
  const id = randomUUID();
  tdb.insert('notifications', {
    id,
    recipient_type: input.recipientType,
    recipient_ref: input.recipientRef,
    channel: 'email',
    kind: input.kind,
    status: 'queued',
    scheduled_for: input.scheduledFor ?? null,
    sent_at: null,
    payload_json: JSON.stringify(input.payload),
    created_at: new Date().toISOString(),
  });
  return id;
}

/**
 * Queue an exception (immediate) notification to every active Admin of the tenant.
 * Admin scope is org-wide (Roles_and_Permissions.md), so org-level exceptions
 * (a decline, a rule-change non-compliance) reach all admins. Returns the ids created.
 */
export function notifyTenantAdmins(
  db: Database.Database,
  tenantId: string,
  payload: Record<string, unknown>
): string[] {
  const tdb = new TenantDB(db, tenantId);
  const admins = tdb.all<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' AND status != 'disabled'`
  );
  return admins.map((a) =>
    queueNotification(db, tenantId, {
      recipientType: 'user',
      recipientRef: a.id,
      kind: 'exception',
      payload,
    })
  );
}

/** Operator (tenant) display name for vendor-facing From branding. */
export function getOperatorName(db: Database.Database, tenantId: string): string | null {
  const row = db.prepare('SELECT name FROM tenants WHERE id = ?').get(tenantId) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}
