/**
 * Re-evaluation hook — triggered when requirement rules change.
 *
 * When an Admin tightens a requirement, vendors that were already approved must be
 * re-evaluated against the new matrix using STORED EXTRACTIONS — no Vision call
 * (AI_Verification_Engine.md § "Rule-change re-evaluation", invariant #7).
 *
 * ADVISORY FLAGS ARE NOT GENERATED HERE — intentional, not an oversight.
 * Rules-only re-evaluation (trigger: rule_change or location_add) compares stored
 * extracted values against the updated requirement matrix. It has no extraction pass
 * and therefore no basis for the pattern-matching observations that produce advisories
 * (coverage_continuity, personal_ach_account, etc.). Advisory generation is exclusive
 * to full pipeline runs where a new document was extracted. See AI_Verification_Engine.md
 * § "Advisory flags" and § "Reuse".
 */

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { logAudit } from '@/lib/audit';
import { runRulesOnlyReeval } from '@/lib/verification/run';
import { notifyTenantAdmins } from '@/lib/notifications/queue';

interface VendorLocationRow {
  vendor_id: string;
  vendor_trade: string;
  status: string;
}

/**
 * Re-evaluate all approved vendors for a tenant after a requirement rule changes.
 *
 * - Reads stored extractions (no new Vision call).
 * - Vendors that now fail → status flips to 'non_compliant'; audit event logged.
 * - Vendors that still pass → no change (no noise for compliant vendors).
 *
 * @param changedKey  The requirement_key that was changed (for scoped re-eval filtering).
 */
export async function triggerRuleChangeReeval(
  db: Db,
  tenantId: string,
  changedKey: string
): Promise<void> {
  const tdb = new TenantDB(db, tenantId);

  // Load all approved vendor-locations for this tenant. Both tenant_id checks want the same
  // value, so both can just reuse $1 (unlike SQLite's positional `?` binding, which needed a
  // second copy of the value passed explicitly for the second occurrence).
  const vendorLocations = await tdb.all<VendorLocationRow>(
    `SELECT vl.vendor_id, v.trade AS vendor_trade, vl.status
     FROM vendor_locations vl
     JOIN vendors v ON v.id = vl.vendor_id AND v.tenant_id = $1
     WHERE vl.tenant_id = $1 AND vl.status = 'approved'`
  );

  let reevalCount = 0;
  let nonCompliantCount = 0;

  for (const vl of vendorLocations) {
    // Run rules-only re-evaluation (no Vision call, no advisories)
    const result = await runRulesOnlyReeval(db, {
      tenantId,
      vendorId: vl.vendor_id,
      vendorTrade: vl.vendor_trade,
      trigger: 'rule_change',
    });

    reevalCount++;

    if (result.recommendation === 'deficiencies' || result.recommendation === 'uncertain') {
      // Vendor no longer passes — flip to non_compliant
      await tdb.update(
        'vendor_locations',
        { status: 'non_compliant' },
        { vendor_id: vl.vendor_id }
      );

      await logAudit(db, {
        tenantId,
        actorType: 'system',
        actorId: 'rule-change-reeval',
        eventType: 'vendor.non_compliant_rule_change',
        targetType: 'vendor',
        targetId: vl.vendor_id,
        payload: {
          changed_key: changedKey,
          run_id: result.runId,
          recommendation: result.recommendation,
        },
      });

      // Exception (immediate): a rule tightening surfaced new post-approval risk. Admins
      // must learn now, not in the digest (Notifications_and_Communications.md catalog:
      // "Re-evaluation flags vendor Non-Compliant" → Admin → Immediate).
      await notifyTenantAdmins(db, tenantId, {
        type: 'non_compliant_rule_change',
        vendor_id: vl.vendor_id,
        changed_key: changedKey,
        run_id: result.runId,
      });

      nonCompliantCount++;
    }
  }

  // Log the re-eval trigger summary
  await logAudit(db, {
    tenantId,
    actorType: 'system',
    actorId: 'rule-change-reeval',
    eventType: 'requirement.reeval_triggered',
    targetType: 'tenant',
    targetId: tenantId,
    payload: {
      changed_key: changedKey,
      vendors_reevaluated: reevalCount,
      vendors_non_compliant: nonCompliantCount,
    },
  });
}
