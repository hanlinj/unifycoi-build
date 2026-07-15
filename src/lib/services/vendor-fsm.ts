import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';

export type VendorStatus =
  | 'invited_pending'
  | 'onboarding'
  | 'under_review'
  | 'approved'
  | 'expired'
  | 'non_compliant'
  | 'declined';

// Events in scope for Phase 5 only. Phase 6 adds: approve, request_correction, reject, policy_lapse, rule_fail.
export type FSMEvent = 'open_link' | 'submit';

// Transitions for Phase 5. Any event not listed here is illegal.
const ALLOWED: Record<FSMEvent, { from: VendorStatus; to: VendorStatus }> = {
  open_link: { from: 'invited_pending', to: 'onboarding' },
  submit:    { from: 'onboarding',      to: 'under_review' },
};

export class IllegalTransitionError extends Error {
  constructor(current: string, event: FSMEvent) {
    super(`Illegal FSM transition: status='${current}' does not allow event='${event}'`);
  }
}

/**
 * Atomically transition vendor_locations for this vendor+tenant.
 * Default mode (opts.partial unset/false): ALL rows must already be in the expected 'from'
 * state, or this throws IllegalTransitionError — unchanged from pre-partial-mode behavior.
 * Status is per-location (invariant #5); events move all locations together because
 * onboarding and submit apply to the vendor as a whole, not to individual locations.
 *
 * Partial mode (opts.partial: true) — opt-in, 'submit' only: only rows currently in the
 * event's 'from' state are advanced; rows already elsewhere (e.g. 'approved'/'declined' after
 * a correction request reset just the under-review locations back to 'onboarding') are left
 * untouched. Still throws IllegalTransitionError if zero rows are eligible — "nothing to
 * submit" stays a real error, it just isn't triggered by unrelated already-decided locations
 * anymore.
 */
export async function fsmTransition(
  db: Db,
  tenantId: string,
  vendorId: string,
  event: FSMEvent,
  opts: { partial?: boolean } = {}
): Promise<{ locationIds: string[] }> {
  const rule = ALLOWED[event];
  if (!rule) throw new IllegalTransitionError('(unknown)', event);

  const tdb = new TenantDB(db, tenantId);

  return tdb.transaction(async (txTdb) => {
    const rows = await txTdb.all<{ location_id: string; status: string }>(
      'SELECT location_id, status FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2',
      [vendorId]
    );

    if (rows.length === 0) {
      throw new Error(`No vendor_locations found for vendor=${vendorId} in tenant=${tenantId}`);
    }

    if (!opts.partial) {
      for (const row of rows) {
        if (row.status !== rule.from) {
          throw new IllegalTransitionError(row.status, event);
        }
      }
    }

    const eligible = opts.partial ? rows.filter((row) => row.status === rule.from) : rows;
    if (eligible.length === 0) {
      throw new IllegalTransitionError(rows[0].status, event);
    }

    for (const row of eligible) {
      await txTdb.update(
        'vendor_locations',
        { status: rule.to },
        { vendor_id: vendorId, location_id: row.location_id }
      );
    }

    return { locationIds: eligible.map((r) => r.location_id) };
  });
}
