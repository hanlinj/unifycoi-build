// Vendor onboarding transitions that need audit attribution.
//
// Extracted from the tokenized GET route so the open_link transition + its audit event
// are exercised by the same code in tests and in production (the route is a thin caller).

import type Database from 'better-sqlite3';
import { fsmTransition } from '@/lib/services/vendor-fsm';
import { logAudit } from '@/lib/audit';

/**
 * Fire open_link (Invited/Pending → Onboarding) on the vendor's first access, and audit it.
 * Idempotent: if any location has already advanced past invited_pending, this is a no-op
 * (returns false) — avoids IllegalTransitionError on subsequent GETs.
 *
 * Spec: "onboarding started" is a logged vendor-lifecycle event (Audit_Trail.md); actor = vendor.
 */
export function fireOnboardingStarted(
  db: Database.Database,
  input: {
    tenantId: string;
    vendorId: string;
    inviteId: string;
    purpose: string;
    vendorLocations: { status: string }[];
  }
): boolean {
  const { tenantId, vendorId, inviteId, purpose, vendorLocations } = input;

  const allPending =
    vendorLocations.length > 0 && vendorLocations.every((vl) => vl.status === 'invited_pending');
  if (!allPending) return false;

  fsmTransition(db, tenantId, vendorId, 'open_link');
  logAudit(db, {
    tenantId,
    actorType: 'vendor',
    actorId: vendorId,
    eventType: 'vendor.onboarding_started',
    targetType: 'vendor',
    targetId: vendorId,
    payload: { invite_id: inviteId, purpose },
  });
  return true;
}
