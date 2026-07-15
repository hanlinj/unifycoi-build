// Command Center taxonomy — the exception-first triage queue (Slice A).
//
// One row PER VENDOR (the decision surface is the Vendor Record), classified by its most
// severe in-scope per-location condition into one of three tiers:
//   Tier 1 "Needs action now"  — active liability OR a vendor blocked awaiting your decision
//   Tier 2 "Move it forward"   — needs a nudge this week, no active liability
//   Tier 3 "In motion"         — ambient health, counts only
//
// Scope-clamped server-side via the caller's resolveScope() result. Expiry derives from the
// chase schedule (chase.ts), per the approved Slice A design.

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { chaseExpiryByVendor } from '@/lib/notifications/chase';
import { expiryBoundaryMs, monthStartMs } from '@/lib/time/zone';

const DAY_MS = 24 * 60 * 60 * 1000;
const IMMINENT_DAYS = 7;        // ≤7d to expiry → Tier 1 imminent lapse
const EXPIRING_SOON_DAYS = 60;  // 8–60d → Tier 2 expiring soon
const CORRECTION_AGING_DAYS = 5;

export type Tier1Condition =
  | 'expired'
  | 'non_compliant'
  | 'imminent_lapse'
  | 'review_deficiencies'
  | 'review_uncertain'
  | 'review_ready';
export type Tier2Condition = 'expiring_soon' | 'correction_aging' | 'invite_failed';

export interface CommandCenterRow {
  vendorId: string;
  vendorName: string;
  trade: string;
  condition: Tier1Condition | Tier2Condition;
  phrase: string;
  locationsAffected: number;
  since: string | null;        // ISO timestamp the UI renders as "Xd ago" (best-effort)
  daysToExpiry: number | null; // populated for expiry rows
  action: 'vendor_record' | 'resend_invite';
}

export interface CommandCenterResult {
  tier1: CommandCenterRow[];
  tier2: CommandCenterRow[];
  tier3: { onboarding: number; pending: number; onTrack: number };
  facilitiesInScope: number;
  // Distinct in-scope vendors, EXCLUDING declined-only ones (every in-scope location declined
  // — a rejected applicant, not a vendor the operator works with; see isDeclinedOnly). Same
  // scoped vendor_locations join the taxonomy itself aggregates over (byVendor below), so it
  // agrees by construction with what the rest of this page considers "in scope."
  totalVendorsInScope: number;
}

export interface CCScope {
  locationIds: string[] | null; // null = org-wide (admin); [] = nothing in scope
}

interface VLoc { vendor_id: string; location_id: string; status: string; flags_json: string | null; business_name: string; trade: string }
interface VendorAgg {
  vendorId: string; name: string; trade: string;
  statuses: string[];
  inScopeLocations: number;
}

/**
 * True when every in-scope vendor_locations status for a vendor is 'declined' — a rejected
 * applicant, not a vendor the operator works with. This is the same condition that already
 * silently drops a vendor from the risk queue: none of the classify loop's `statuses.has(...)`
 * branches below match 'declined', so a vendor whose statuses are ALL 'declined' falls through
 * every branch and is never pushed to tier1/tier2 or counted in tier3 ("declined-only vendors
 * are terminal → not surfaced"). Total vendors / New vendors (mo) apply this same predicate
 * explicitly, rather than re-deriving "who got skipped" from the loop's side effects.
 * Empty input is NOT declined-only (no data to judge) — callers only call this for vendors
 * known to have ≥1 in-scope location, so this only guards against a theoretical empty array.
 */
function isDeclinedOnly(statuses: string[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === 'declined');
}

function humanizeReq(key: string): string {
  const parts = key.split('.');
  const head = parts[0];
  const rest = ['coverage', 'coverage_required', 'endorsement', 'doc_required'].includes(head)
    ? parts.slice(1)
    : parts;
  const text = rest.map((p) => p.replace(/_/g, ' ')).join(' — ');
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function buildCommandCenter(
  db: Db,
  tenantId: string,
  scope: CCScope,
  nowMs: number = Date.now()
): Promise<CommandCenterResult> {
  const empty: CommandCenterResult = { tier1: [], tier2: [], tier3: { onboarding: 0, pending: 0, onTrack: 0 }, facilitiesInScope: 0, totalVendorsInScope: 0 };

  // District/store with no in-scope locations → nothing.
  if (scope.locationIds !== null && scope.locationIds.length === 0) return empty;

  const tdb = new TenantDB(db, tenantId);
  const scoped = scope.locationIds !== null;
  const locParams = scoped ? scope.locationIds! : [];
  // tenant_id is bound as $1 (TenantDB's contract); the IN-list starts at $2.
  const locPlaceholders = locParams.map((_, i) => `$${i + 2}`).join(', ');
  const locFilter = scoped ? ` AND vl.location_id IN (${locPlaceholders})` : '';

  // Facilities in scope (for the empty-state count) — always SCOPE-SCOPED and active-only.
  // Admin (scope.locationIds === null): org-wide active count.
  // District: count of active locations across their regions (resolveScope's location set).
  // Store Manager: count of their assigned active locations.
  // COUNT(*) returns as a string (Postgres bigint precision safety) — cast before using as a number.
  const facilitiesInScope = scoped
    ? Number(
        (await tdb.get<{ n: string }>(
          `SELECT COUNT(*) AS n FROM locations
           WHERE tenant_id = $1 AND status = 'active' AND id IN (${locPlaceholders})`,
          locParams
        ))!.n
      )
    : Number((await tdb.get<{ n: string }>(`SELECT COUNT(*) AS n FROM locations WHERE tenant_id = $1 AND status = 'active'`))!.n);

  // 1. In-scope vendor-locations + vendor identity.
  const vlocs = await tdb.all<VLoc>(
    `SELECT vl.vendor_id, vl.location_id, vl.status, vl.flags_json, v.business_name, v.trade
     FROM vendor_locations vl
     JOIN vendors v ON v.id = vl.vendor_id AND v.tenant_id = vl.tenant_id
     WHERE vl.tenant_id = $1${locFilter}`,
    locParams
  );
  if (vlocs.length === 0) return { ...empty, facilitiesInScope };

  const byVendor = new Map<string, VendorAgg>();
  for (const r of vlocs) {
    let agg = byVendor.get(r.vendor_id);
    if (!agg) { agg = { vendorId: r.vendor_id, name: r.business_name, trade: r.trade, statuses: [], inScopeLocations: 0 }; byVendor.set(r.vendor_id, agg); }
    agg.statuses.push(r.status);
    agg.inScopeLocations++;
  }

  // 2. Latest verification run per vendor (recommendation + timestamp).
  const runs = await tdb.all<{ id: string; vendor_id: string; recommendation: string; created_at: string }>(
    `SELECT id, vendor_id, recommendation, created_at FROM verification_runs WHERE tenant_id = $1 ORDER BY created_at DESC`
  );
  const latestRun = new Map<string, { id: string; recommendation: string; created_at: string }>();
  for (const r of runs) if (!latestRun.has(r.vendor_id)) latestRun.set(r.vendor_id, r);

  // 3. Deficient requirement evaluations for the latest runs (for specific phrases).
  const latestRunIds = [...latestRun.values()].map((r) => r.id);
  const defByVendor = new Map<string, { count: number; topKey: string }>();
  if (latestRunIds.length > 0) {
    // tenant_id is $1; run_id IN-list starts at $2.
    const runIdPlaceholders = latestRunIds.map((_, i) => `$${i + 2}`).join(', ');
    const evals = await tdb.all<{ vendor_id: string; requirement_key: string }>(
      `SELECT vendor_id, requirement_key FROM requirement_evaluations
       WHERE tenant_id = $1 AND outcome = 'deficient' AND run_id IN (${runIdPlaceholders})
       ORDER BY requirement_key`,
      latestRunIds
    );
    for (const e of evals) {
      const cur = defByVendor.get(e.vendor_id);
      if (!cur) defByVendor.set(e.vendor_id, { count: 1, topKey: e.requirement_key });
      else cur.count++;
    }
  }

  // 4. Chase expiry per vendor.
  const expiryMap = await chaseExpiryByVendor(db, tenantId);
  // OPS-7: days-to-expiry buckets resolve the expiry boundary in the tenant's timezone, so
  // they agree with the day-0 flip (which uses the same expiryBoundaryMs). Null tz → UTC.
  const tenantRow = await db.selectFrom('tenants').select('timezone').where('id', '=', tenantId).executeTakeFirst();
  const tz = tenantRow?.timezone ?? null;

  // 5. Invites per vendor (correction aging + delivery failures).
  const invites = await tdb.all<{ vendor_id: string | null; purpose: string; delivery_state: string; created_at: string }>(
    `SELECT vendor_id, purpose, delivery_state, created_at FROM invites WHERE tenant_id = $1`
  );
  const inviteAgg = new Map<string, { bouncedAt: string | null; correctionSentAt: string | null }>();
  for (const inv of invites) {
    if (!inv.vendor_id) continue;
    const cur = inviteAgg.get(inv.vendor_id) ?? { bouncedAt: null, correctionSentAt: null };
    if (inv.delivery_state === 'bounced' || inv.delivery_state === 'expired_invite') cur.bouncedAt = inv.created_at;
    if (inv.purpose === 'correction' && inv.delivery_state === 'sent') cur.correctionSentAt = inv.created_at;
    inviteAgg.set(inv.vendor_id, cur);
  }

  // ── Classify ───────────────────────────────────────────────────────────────────
  const now = nowMs;
  const tier1: CommandCenterRow[] = [];
  const tier2: CommandCenterRow[] = [];
  let onboarding = 0, pending = 0, onTrack = 0;

  for (const agg of byVendor.values()) {
    const statuses = new Set(agg.statuses);
    const run = latestRun.get(agg.vendorId);
    const def = defByVendor.get(agg.vendorId);
    const expiresAt = expiryMap.get(agg.vendorId) ?? null;
    const daysToExpiry = expiresAt ? Math.floor((expiryBoundaryMs(expiresAt, tz) - now) / DAY_MS) : null;
    const inv = inviteAgg.get(agg.vendorId);
    const base = { vendorId: agg.vendorId, vendorName: agg.name, trade: agg.trade, locationsAffected: agg.inScopeLocations };
    const since = run?.created_at ?? null;

    // Most-severe first.
    if (statuses.has('expired')) {
      tier1.push({ ...base, condition: 'expired', phrase: 'Coverage expired — pulled from hireable', since, daysToExpiry: null, action: 'vendor_record' });
    } else if (statuses.has('non_compliant')) {
      const phrase = def ? `Non-compliant: ${humanizeReq(def.topKey)}` : 'Non-compliant: failed a tightened requirement';
      tier1.push({ ...base, condition: 'non_compliant', phrase, since, daysToExpiry: null, action: 'vendor_record' });
    } else if (statuses.has('approved') && daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= IMMINENT_DAYS) {
      tier1.push({ ...base, condition: 'imminent_lapse', phrase: `Expires in ${daysToExpiry}d · no renewal uploaded`, since: null, daysToExpiry, action: 'vendor_record' });
    } else if (statuses.has('under_review') && run?.recommendation === 'deficiencies') {
      const phrase = def && def.count > 1 ? `Deficient: ${def.count} failed requirements` : `Deficient: ${def ? humanizeReq(def.topKey) : 'requirement not met'}`;
      tier1.push({ ...base, condition: 'review_deficiencies', phrase, since, daysToExpiry: null, action: 'vendor_record' });
    } else if (statuses.has('under_review') && run?.recommendation === 'uncertain') {
      tier1.push({ ...base, condition: 'review_uncertain', phrase: 'Uncertain — needs your call', since, daysToExpiry: null, action: 'vendor_record' });
    } else if (statuses.has('under_review') && run?.recommendation === 'approve') {
      tier1.push({ ...base, condition: 'review_ready', phrase: 'Ready to approve', since, daysToExpiry: null, action: 'vendor_record' });
    } else if (statuses.has('under_review')) {
      // Under review with no run yet (shouldn't happen post-submit) — treat as ready/pending decision.
      tier1.push({ ...base, condition: 'review_ready', phrase: 'Awaiting review', since, daysToExpiry: null, action: 'vendor_record' });
    } else if (statuses.has('approved') && daysToExpiry !== null && daysToExpiry > IMMINENT_DAYS && daysToExpiry <= EXPIRING_SOON_DAYS) {
      tier2.push({ ...base, condition: 'expiring_soon', phrase: `Expires in ${daysToExpiry}d · reminder sent`, since: null, daysToExpiry, action: 'vendor_record' });
    } else if (inv?.correctionSentAt && (now - Date.parse(inv.correctionSentAt)) / DAY_MS >= CORRECTION_AGING_DAYS && statuses.has('onboarding')) {
      const ageDays = Math.floor((now - Date.parse(inv.correctionSentAt)) / DAY_MS);
      tier2.push({ ...base, condition: 'correction_aging', phrase: `Correction sent ${ageDays}d ago · no response`, since: inv.correctionSentAt, daysToExpiry: null, action: 'vendor_record' });
    } else if (inv?.bouncedAt) {
      tier2.push({ ...base, condition: 'invite_failed', phrase: 'Invite bounced · resend', since: inv.bouncedAt, daysToExpiry: null, action: 'resend_invite' });
    } else if (statuses.has('onboarding')) {
      onboarding++;
    } else if (statuses.has('invited_pending')) {
      pending++;
    } else if (statuses.has('approved')) {
      onTrack++;
    }
    // declined-only vendors are terminal → not surfaced.
  }

  // Tier 1 sub-rank by severity order.
  const t1order: Tier1Condition[] = ['expired', 'non_compliant', 'imminent_lapse', 'review_deficiencies', 'review_uncertain', 'review_ready'];
  tier1.sort((a, b) => t1order.indexOf(a.condition as Tier1Condition) - t1order.indexOf(b.condition as Tier1Condition));
  const t2order: Tier2Condition[] = ['expiring_soon', 'correction_aging', 'invite_failed'];
  tier2.sort((a, b) => t2order.indexOf(a.condition as Tier2Condition) - t2order.indexOf(b.condition as Tier2Condition));

  let totalVendorsInScope = 0;
  for (const agg of byVendor.values()) {
    if (!isDeclinedOnly(agg.statuses)) totalVendorsInScope++;
  }

  return { tier1, tier2, tier3: { onboarding, pending, onTrack }, facilitiesInScope, totalVendorsInScope };
}

/**
 * Count of vendors newly created this tenant-local calendar month, scope-clamped identically
 * to buildCommandCenter (same vendor_locations join + IN-list pattern), EXCLUDING declined-only
 * vendors via the same isDeclinedOnly predicate Total vendors uses — so a month where a vendor
 * was created and then declined everywhere can't render New vendors > Total vendors. Defined by
 * vendors.created_at — a vendor has exactly one creation event but can receive multiple
 * invites over time (onboarding/renewal/correction), so created_at is the unambiguous "new to
 * the tenant" signal, not invite timestamp. Month boundary is tenant-local (monthStartMs,
 * OPS-7's Intl-based day-boundary treatment extended to month grain) — never a naive UTC
 * month cutoff.
 */
export async function countNewVendorsThisMonth(
  db: Db,
  tenantId: string,
  scope: CCScope,
  nowMs: number = Date.now()
): Promise<number> {
  if (scope.locationIds !== null && scope.locationIds.length === 0) return 0;

  const tdb = new TenantDB(db, tenantId);
  const scoped = scope.locationIds !== null;
  const locParams = scoped ? scope.locationIds! : [];

  const tenantRow = await db.selectFrom('tenants').select('timezone').where('id', '=', tenantId).executeTakeFirst();
  const monthStart = monthStartMs(nowMs, tenantRow?.timezone ?? null);

  // tenant_id is $1 (TenantDB's contract); created_at cutoff is $2; the location IN-list (if
  // scoped) starts at $3.
  const locPlaceholders = locParams.map((_, i) => `$${i + 3}`).join(', ');
  const locFilter = scoped ? ` AND vl.location_id IN (${locPlaceholders})` : '';

  // Per-(vendor, in-scope location) status rows, not a plain COUNT — declined-only exclusion
  // needs every in-scope location's status for each vendor created this month, same as
  // byVendor's aggregation in buildCommandCenter.
  const rows = await tdb.all<{ vendor_id: string; status: string }>(
    `SELECT v.id AS vendor_id, vl.status
     FROM vendors v
     JOIN vendor_locations vl ON vl.vendor_id = v.id AND vl.tenant_id = v.tenant_id
     WHERE v.tenant_id = $1 AND v.created_at >= $2${locFilter}`,
    [new Date(monthStart), ...locParams]
  );

  const statusesByVendor = new Map<string, string[]>();
  for (const r of rows) {
    const arr = statusesByVendor.get(r.vendor_id);
    if (arr) arr.push(r.status);
    else statusesByVendor.set(r.vendor_id, [r.status]);
  }

  let count = 0;
  for (const statuses of statusesByVendor.values()) {
    if (!isDeclinedOnly(statuses)) count++;
  }
  return count;
}
