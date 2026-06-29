import type Database from 'better-sqlite3';
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
 * Atomically transition ALL vendor_locations for this vendor+tenant.
 * Throws IllegalTransitionError if any location is not in the expected 'from' state.
 * Status is per-location (invariant #5); events move all locations together because
 * onboarding and submit apply to the vendor as a whole, not to individual locations.
 */
export function fsmTransition(
  db: Database.Database,
  tenantId: string,
  vendorId: string,
  event: FSMEvent
): { locationIds: string[] } {
  const rule = ALLOWED[event];
  if (!rule) throw new IllegalTransitionError('(unknown)', event);

  const tdb = new TenantDB(db, tenantId);

  return tdb.transaction((txTdb) => {
    const rows = txTdb.all<{ location_id: string; status: string }>(
      'SELECT location_id, status FROM vendor_locations WHERE tenant_id = ? AND vendor_id = ?',
      [vendorId]
    );

    if (rows.length === 0) {
      throw new Error(`No vendor_locations found for vendor=${vendorId} in tenant=${tenantId}`);
    }

    for (const row of rows) {
      if (row.status !== rule.from) {
        throw new IllegalTransitionError(row.status, event);
      }
    }

    for (const row of rows) {
      txTdb.update(
        'vendor_locations',
        { status: rule.to },
        { vendor_id: vendorId, location_id: row.location_id }
      );
    }

    return { locationIds: rows.map((r) => r.location_id) };
  });
}
