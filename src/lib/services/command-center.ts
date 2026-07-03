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

import type Database from 'better-sqlite3';
import { TenantDB } from '@/lib/db/tenant';
import { chaseExpiryByVendor } from '@/lib/notifications/chase';
import { expiryBoundaryMs } from '@/lib/time/zone';

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

function humanizeReq(key: string): string {
  const parts = key.split('.');
  const head = parts[0];
  const rest = ['coverage', 'coverage_required', 'endorsement', 'doc_required'].includes(head)
    ? parts.slice(1)
    : parts;
  const text = rest.map((p) => p.replace(/_/g, ' ')).join(' — ');
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildCommandCenter(
  db: Database.Database,
  tenantId: string,
  scope: CCScope,
  nowMs: number = Date.now()
): CommandCenterResult {
  const empty: CommandCenterResult = { tier1: [], tier2: [], tier3: { onboarding: 0, pending: 0, onTrack: 0 }, facilitiesInScope: 0 };

  // District/store with no in-scope locations → nothing.
  if (scope.locationIds !== null && scope.locationIds.length === 0) return empty;

  const tdb = new TenantDB(db, tenantId);
  const scoped = scope.locationIds !== null;
  const locParams = scoped ? scope.locationIds! : [];
  const locFilter = scoped ? ` AND vl.location_id IN (${locParams.map(() => '?').join(', ')})` : '';

  // Facilities in scope (for the empty-state count) — always SCOPE-SCOPED and active-only.
  // Admin (scope.locationIds === null): org-wide active count.
  // District: count of active locations across their regions (resolveScope's location set).
  // Store Manager: count of their assigned active locations.
  const facilitiesInScope = scoped
    ? tdb.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM locations
         WHERE tenant_id = ? AND status = 'active' AND id IN (${locParams.map(() => '?').join(', ')})`,
        locParams
      )!.n
    : tdb.get<{ n: number }>(`SELECT COUNT(*) AS n FROM locations WHERE tenant_id = ? AND status = 'active'`)!.n;

  // 1. In-scope vendor-locations + vendor identity.
  const vlocs = tdb.all<VLoc>(
    `SELECT vl.vendor_id, vl.location_id, vl.status, vl.flags_json, v.business_name, v.trade
     FROM vendor_locations vl
     JOIN vendors v ON v.id = vl.vendor_id AND v.tenant_id = vl.tenant_id
     WHERE vl.tenant_id = ?${locFilter}`,
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
  const runs = tdb.all<{ id: string; vendor_id: string; recommendation: string; created_at: string }>(
    `SELECT id, vendor_id, recommendation, created_at FROM verification_runs WHERE tenant_id = ? ORDER BY created_at DESC`
  );
  const latestRun = new Map<string, { id: string; recommendation: string; created_at: string }>();
  for (const r of runs) if (!latestRun.has(r.vendor_id)) latestRun.set(r.vendor_id, r);

  // 3. Deficient requirement evaluations for the latest runs (for specific phrases).
  const latestRunIds = [...latestRun.values()].map((r) => r.id);
  const defByVendor = new Map<string, { count: number; topKey: string }>();
  if (latestRunIds.length > 0) {
    const evals = tdb.all<{ vendor_id: string; requirement_key: string }>(
      `SELECT vendor_id, requirement_key FROM requirement_evaluations
       WHERE tenant_id = ? AND outcome = 'deficient' AND run_id IN (${latestRunIds.map(() => '?').join(', ')})
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
  const expiryMap = chaseExpiryByVendor(db, tenantId);
  // OPS-7: days-to-expiry buckets resolve the expiry boundary in the tenant's timezone, so
  // they agree with the day-0 flip (which uses the same expiryBoundaryMs). Null tz → UTC.
  const tz = (db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(tenantId) as { timezone: string | null } | undefined)?.timezone ?? null;

  // 5. Invites per vendor (correction aging + delivery failures).
  const invites = tdb.all<{ vendor_id: string | null; purpose: string; delivery_state: string; created_at: string }>(
    `SELECT vendor_id, purpose, delivery_state, created_at FROM invites WHERE tenant_id = ?`
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

  return { tier1, tier2, tier3: { onboarding, pending, onTrack }, facilitiesInScope };
}
