// Vendor onboarding transitions that need audit attribution.
//
// Extracted from the tokenized GET route so the open_link transition + its audit event
// are exercised by the same code in tests and in production (the route is a thin caller).

import type { Db } from '@/lib/db/client';
import { fsmTransition } from '@/lib/services/vendor-fsm';
import { logAudit } from '@/lib/audit';

/**
 * Fire open_link (Invited/Pending → Onboarding) on the vendor's first access, and audit it.
 * Idempotent: if any location has already advanced past invited_pending, this is a no-op
 * (returns false) — avoids IllegalTransitionError on subsequent GETs.
 *
 * Spec: "onboarding started" is a logged vendor-lifecycle event (Audit_Trail.md); actor = vendor.
 *
 * The ONLY call site now (Stage 6b) — the portal page (`src/app/v/[token]/page.tsx`) previously
 * had its own inline `fsmTransition()` call that bypassed this function entirely, silently
 * skipping the audit event on every page-load-triggered open_link (only the GET API route's
 * call went through here and got audited). Both callers landed in this stage's conversion
 * surface, so the duplication is collapsed here rather than left to drift further.
 */
export async function fireOnboardingStarted(
  db: Db,
  input: {
    tenantId: string;
    vendorId: string;
    inviteId: string;
    purpose: string;
    vendorLocations: { status: string }[];
  }
): Promise<boolean> {
  const { tenantId, vendorId, inviteId, purpose, vendorLocations } = input;

  const allPending =
    vendorLocations.length > 0 && vendorLocations.every((vl) => vl.status === 'invited_pending');
  if (!allPending) return false;

  await fsmTransition(db, tenantId, vendorId, 'open_link');
  await logAudit(db, {
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
