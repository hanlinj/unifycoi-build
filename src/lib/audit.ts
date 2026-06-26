import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
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

export function logAudit(db: Database.Database, event: AuditEventInput): void {
  const tdb = new TenantDB(db, event.tenantId);
  tdb.insert('audit_events', {
    id: randomUUID(),
    actor_type: event.actorType,
    actor_id: event.actorId ?? null,
    event_type: event.eventType,
    target_type: event.targetType ?? null,
    target_id: event.targetId ?? null,
    payload_json: event.payload ? JSON.stringify(event.payload) : null,
    created_at: new Date().toISOString(),
  });
}
