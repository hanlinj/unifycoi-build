import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';

export interface AuditEventInput {
  tenantId: string;
  actorType: 'system' | 'ai' | 'user' | 'vendor' | 'platform';
  actorId?: string | null;
  eventType: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function logAudit(db: Db, event: AuditEventInput): Promise<void> {
  const tdb = new TenantDB(db, event.tenantId);
  await tdb.insert('audit_events', {
    id: randomUUID(),
    actor_type: event.actorType,
    actor_id: event.actorId ?? null,
    event_type: event.eventType,
    target_type: event.targetType ?? null,
    target_id: event.targetId ?? null,
    payload_json: event.payload ? JSON.stringify(event.payload) : null,
    created_at: new Date(),
  });
}
