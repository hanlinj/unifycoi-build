// The six report builders. Pure reads; Sensitive data never touched (these query
// vendor_locations, audit_events, requirement_evaluations, chase notifications, and COI
// coverage fields only — no W-9/ACH Sensitive leaves).

import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { expiryBoundaryMs } from '@/lib/time/zone';
import {
  reportMeta, type ReportKey, type ReportScope, type ReportFilters, type ReportResult,
  effectiveLocationIds, vendorIdsInScope, inClause,
} from './index';

const DAY = 86_400_000;

function deriveOverall(statuses: string[]): string {
  const s = new Set(statuses);
  for (const st of ['expired', 'non_compliant', 'under_review', 'onboarding', 'invited_pending', 'approved', 'declined']) {
    if (s.has(st)) return st;
  }
  return statuses[0] ?? 'unknown';
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

// ── #1 Compliance Posture Over Time (Option A: event-activity trend + current snapshot) ──

async function compliancePosture(db: Db, tenantId: string, vendorIds: string[], filters: ReportFilters, effLoc: string[] | null, nowMs: number) {
  const tdb = new TenantDB(db, tenantId);

  // Current snapshot — counts of vendor_locations by status, within scope.
  const locFilter = effLoc === null ? '' : effLoc.length === 0 ? ' AND 1=0' : ` AND location_id IN (${inClause(effLoc.length, 2)})`;
  const snapRows = await tdb.all<{ status: string; n: string }>(
    `SELECT status, COUNT(*) AS n FROM vendor_locations WHERE tenant_id = $1${locFilter} GROUP BY status`,
    effLoc ?? []
  );
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of snapRows) { const n = Number(r.n); counts[r.status] = n; total += n; } // COUNT(*) is bigint-as-string (invariant 3)
  const approved = counts['approved'] ?? 0;
  const compliantPct = total > 0 ? Math.round((approved / total) * 1000) / 10 : 0;

  // Trend — status-transition audit events bucketed by month over [from, to].
  const to = filters.to ?? new Date(nowMs).toISOString();
  const from = filters.from ?? new Date(nowMs - 180 * DAY).toISOString();
  const TREND_TYPES = ['vendor.approved', 'vendor.expired', 'vendor.non_compliant_rule_change', 'vendor.declined', 'vendor.submitted', 'vendor.onboarding_started'] as const;
  const trend: Record<string, Record<string, number>> = {};
  if (vendorIds.length > 0) {
    const evs = await tdb.all<{ event_type: string; created_at: string }>(
      `SELECT event_type, created_at FROM audit_events
       WHERE tenant_id = $1 AND target_type = 'vendor' AND target_id IN (${inClause(vendorIds.length, 4)})
         AND event_type IN (${inClause(TREND_TYPES.length, 4 + vendorIds.length)})
         AND created_at >= $2 AND created_at <= $3`,
      [from, to, ...vendorIds, ...TREND_TYPES]
    );
    for (const e of evs) {
      const k = monthKey(e.created_at);
      trend[k] = trend[k] ?? {};
      trend[k][e.event_type] = (trend[k][e.event_type] ?? 0) + 1;
    }
  }
  const trendRows = Object.keys(trend).sort().map((period) => ({ period, ...trend[period] }));

  return {
    snapshot: { counts, total, approved, compliantPct },
    trend: trendRows,
    range: { from, to },
    note: 'Trend is event-activity (transitions per month) + current posture snapshot (Option A — no historical posture reconstruction in v1).',
  };
}

// ── #2 Expiration & Renewal Forecast ────────────────────────────────────────────────

interface ChaseForecastRow { vendor_id: string; exp: string; rung: number | null }

/**
 * Batched replacement for the old json_extract MIN() query (invariants 5–6). `exp` needs the
 * chronologically-earliest expiration_date's UNTOUCHED text — a real MIN() over a jsonb->>
 * TEXT column is a lexicographic (wrong) comparison, and casting-then-reformatting
 * (`to_char`) is the trap chase.ts already found and rejected (it silently turns a
 * DATE_ONLY value into a full timestamp, breaking expiryBoundaryMs's format detection
 * downstream). So `exp` comes from `DISTINCT ON (vendor_id) ... ORDER BY (expiration_date)
 * ::timestamptz`, exactly chase.ts's chaseExpiryByVendor pattern — cast only to order,
 * never to reformat. `rung` is a genuinely numeric MIN() (days_before is int-castable and
 * has no lexicographic-order trap), computed separately and joined in: DISTINCT ON picks
 * ONE row per vendor, and that row's own days_before isn't necessarily the group's minimum
 * (a coi_expiration row has no days_before at all — MIN() correctly skips the NULL, same
 * as the original json_extract(...) which returned NULL for a missing key).
 */
async function chaseForecastRows(db: Db, tenantId: string, vendorIds: string[]): Promise<ChaseForecastRow[]> {
  if (vendorIds.length === 0) return [];
  const tdb = new TenantDB(db, tenantId);
  return tdb.all<ChaseForecastRow>(
    `WITH candidates AS (
       SELECT payload_json->>'vendor_id'          AS vendor_id,
              payload_json->>'expiration_date'    AS expiration_date,
              (payload_json->>'days_before')::int AS days_before
       FROM notifications
       WHERE tenant_id = $1 AND status = 'queued'
         AND payload_json->>'type' IN ('renewal_reminder', 'coi_expiration')
         AND payload_json->>'vendor_id' IN (${inClause(vendorIds.length, 2)})
     ),
     exp_pick AS (
       SELECT DISTINCT ON (vendor_id) vendor_id, expiration_date AS exp
       FROM candidates
       WHERE expiration_date IS NOT NULL
       ORDER BY vendor_id, (expiration_date)::timestamptz ASC
     ),
     rung_pick AS (
       SELECT vendor_id, MIN(days_before) AS rung
       FROM candidates
       GROUP BY vendor_id
     )
     SELECT exp_pick.vendor_id, exp_pick.exp, rung_pick.rung
     FROM exp_pick JOIN rung_pick USING (vendor_id)`,
    vendorIds
  );
}

async function renewalForecast(db: Db, tenantId: string, vendorIds: string[], effLoc: string[] | null, nowMs: number) {
  const tdb = new TenantDB(db, tenantId);
  // OPS-7: days-out resolves the expiry boundary in the tenant's timezone (matches the flip
  // + Command Center buckets). Null tz → UTC.
  const tenantRow = await db.selectFrom('tenants').select('timezone').where('id', '=', tenantId).executeTakeFirst();
  const tz = tenantRow?.timezone ?? null;
  if (vendorIds.length === 0) return { rows: [], buckets: { d30: 0, d60: 0, d90: 0, beyond: 0 } };

  const chase = await chaseForecastRows(db, tenantId, vendorIds);
  const withExp = chase.filter((c) => c.exp);

  // Batched (not N+1): one query for all vendors' names/trades, one for all their in-scope
  // locations, instead of two per chase row.
  const chaseVendorIds = [...new Set(withExp.map((c) => c.vendor_id))];
  const vendorRows = chaseVendorIds.length
    ? await tdb.all<{ id: string; business_name: string; trade: string }>(
        `SELECT id, business_name, trade FROM vendors WHERE tenant_id = $1 AND id IN (${inClause(chaseVendorIds.length, 2)})`,
        chaseVendorIds
      )
    : [];
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));

  const locClause = effLoc === null ? '' : ` AND vl.location_id IN (${inClause(effLoc.length, 2 + chaseVendorIds.length)})`;
  const locRows = chaseVendorIds.length
    ? await tdb.all<{ vendor_id: string; name: string }>(
        `SELECT vl.vendor_id, l.name FROM vendor_locations vl JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
         WHERE vl.tenant_id = $1 AND vl.vendor_id IN (${inClause(chaseVendorIds.length, 2)})${locClause}`,
        effLoc === null ? chaseVendorIds : [...chaseVendorIds, ...effLoc]
      )
    : [];
  const locsByVendor = new Map<string, string[]>();
  for (const r of locRows) {
    const list = locsByVendor.get(r.vendor_id) ?? [];
    list.push(r.name);
    locsByVendor.set(r.vendor_id, list);
  }

  const buckets = { d30: 0, d60: 0, d90: 0, beyond: 0 };
  const rows = withExp
    .map((c) => {
      const daysOut = Math.floor((expiryBoundaryMs(c.exp, tz) - nowMs) / DAY);
      const bucket = daysOut <= 30 ? 'd30' : daysOut <= 60 ? 'd60' : daysOut <= 90 ? 'd90' : 'beyond';
      buckets[bucket as keyof typeof buckets]++;
      const v = vendorById.get(c.vendor_id)!;
      const locs = locsByVendor.get(c.vendor_id) ?? [];
      return { vendorId: c.vendor_id, vendorName: v.business_name, trade: v.trade, locations: locs, expirationDate: c.exp, daysOut, bucket, nextRung: c.rung };
    })
    .sort((a, b) => a.daysOut - b.daysOut);

  return { rows, buckets };
}

// ── #3 Vendor Roster & Coverage (Standard coverage facts only) ──────────────────────

async function vendorRoster(db: Db, tenantId: string, vendorIds: string[], effLoc: string[] | null) {
  const tdb = new TenantDB(db, tenantId);
  // N+1, preserved (not collapsed): correctness-first per Stage 9 instruction. Collapsing this
  // one cleanly needs two more DISTINCT ON batches (latest active COI per vendor, latest
  // extraction per document) layered on top of the vendor+location batch — a real rewrite of
  // coiCoverageSummary's shape, not a mechanical collapse like renewalForecast's. Flagged as a
  // post-migration performance item in Shortcuts & gaps rather than expanding this stage's scope.
  const rows = [];
  for (const vid of vendorIds) {
    const v = (await tdb.get<{ business_name: string; trade: string }>('SELECT business_name, trade FROM vendors WHERE tenant_id = $1 AND id = $2', [vid]))!;
    const vls = await tdb.all<{ location_id: string; name: string; status: string }>(
      `SELECT vl.location_id, l.name, vl.status FROM vendor_locations vl
       JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
       WHERE vl.tenant_id = $1 AND vl.vendor_id = $2${effLoc === null ? '' : ` AND vl.location_id IN (${inClause(effLoc.length, 3)})`}`,
      effLoc === null ? [vid] : [vid, ...effLoc]
    );
    const coverage = await coiCoverageSummary(db, tenantId, vid);
    rows.push({
      vendorId: vid,
      vendorName: v.business_name,
      trade: v.trade,
      overallStatus: deriveOverall(vls.map((x) => x.status)),
      locations: vls.map((x) => x.name),
      coverage,
    });
  }
  rows.sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  return { rows };
}

/** Compact Standard coverage facts from the latest active COI extraction (no Sensitive data). */
async function coiCoverageSummary(db: Db, tenantId: string, vendorId: string): Promise<{ glEachOccurrence: number | null; additionalInsured: boolean | null; waiverOfSubrogation: boolean | null }> {
  const tdb = new TenantDB(db, tenantId);
  const doc = await tdb.get<{ id: string }>(
    `SELECT d.id FROM documents d WHERE d.tenant_id = $1 AND d.vendor_id = $2 AND d.doc_type = 'coi' AND d.state = 'active' AND d.superseded_by IS NULL ORDER BY d.uploaded_at DESC LIMIT 1`,
    [vendorId]
  );
  if (!doc) return { glEachOccurrence: null, additionalInsured: null, waiverOfSubrogation: null };
  const ex = await tdb.get<{ payload_json: Record<string, unknown> }>(
    'SELECT payload_json FROM extractions WHERE tenant_id = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 1',
    [doc.id]
  );
  if (!ex) return { glEachOccurrence: null, additionalInsured: null, waiverOfSubrogation: null };
  // jsonb — already parsed, never JSON.parse() (invariant 2). Caught in the pre-flight trace
  // before this stage ran (proactive) — the old SQLite code's JSON.parse() would have thrown
  // "[object Object]" is not valid JSON the first time a Sensitive-included... actually any
  // vendor-roster run with a COI on file hit this, same landmine class as Stage 4/8c.
  const p = ex.payload_json as { policies?: Array<{ coverage_type?: { value?: string }; limits?: Record<string, { value?: number }>; additional_insured?: { value?: boolean }; waiver_of_subrogation?: { value?: boolean } }> };
  const policies = p.policies ?? [];
  const gl = policies.find((pol) => /general|gl/i.test(pol.coverage_type?.value ?? '')) ?? policies[0];
  const glEach = gl?.limits ? (Object.entries(gl.limits).find(([k]) => /each_occurrence/i.test(k))?.[1]?.value ?? null) : null;
  const ai = policies.some((pol) => pol.additional_insured?.value === true) ? true : policies.length ? false : null;
  const wos = policies.some((pol) => pol.waiver_of_subrogation?.value === true) ? true : policies.length ? false : null;
  return { glEachOccurrence: glEach ?? null, additionalInsured: ai, waiverOfSubrogation: wos };
}

// ── #4 Onboarding Throughput & Funnel ────────────────────────────────────────────────

async function onboardingFunnel(db: Db, tenantId: string, vendorIds: string[]) {
  const tdb = new TenantDB(db, tenantId);
  const M = vendorIds.length;
  if (M === 0) return { reached: { invited: 0, onboarding: 0, underReview: 0, approved: 0 }, conversion: {}, medianDaysInStage: {}, dropOff: {}, coverage: { complete: 0, total: 0 }, note: '' };

  // Earliest timestamp per vendor per stage from the audit trail.
  const stamp = new Map<string, { invited?: string; onboarding?: string; submitted?: string; approved?: string }>();
  const evs = await tdb.all<{ target_id: string; event_type: string; created_at: string }>(
    `SELECT target_id, event_type, created_at FROM audit_events
     WHERE tenant_id = $1 AND target_type = 'vendor' AND target_id IN (${inClause(vendorIds.length, 2)})
       AND event_type IN ('vendor.invited','vendor.onboarding_started','vendor.submitted','vendor.approved')
     ORDER BY created_at ASC`,
    vendorIds
  );
  const key: Record<string, 'invited' | 'onboarding' | 'submitted' | 'approved'> = {
    'vendor.invited': 'invited', 'vendor.onboarding_started': 'onboarding', 'vendor.submitted': 'submitted', 'vendor.approved': 'approved',
  };
  for (const e of evs) {
    const s = stamp.get(e.target_id) ?? {};
    const stage = key[e.event_type];
    if (s[stage] === undefined) s[stage] = e.created_at; // earliest
    stamp.set(e.target_id, s);
  }

  let invited = 0, onboarding = 0, underReview = 0, approved = 0;
  const dur = { inv_onb: [] as number[], onb_sub: [] as number[], sub_app: [] as number[] };
  for (const s of stamp.values()) {
    if (s.invited) invited++;
    if (s.onboarding) onboarding++;
    if (s.submitted) underReview++;
    if (s.approved) approved++;
    if (s.invited && s.onboarding) dur.inv_onb.push((Date.parse(s.onboarding) - Date.parse(s.invited)) / DAY);
    if (s.onboarding && s.submitted) dur.onb_sub.push((Date.parse(s.submitted) - Date.parse(s.onboarding)) / DAY);
    if (s.submitted && s.approved) dur.sub_app.push((Date.parse(s.approved) - Date.parse(s.submitted)) / DAY);
  }
  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const a = [...xs].sort((m, n) => m - n);
    const mid = Math.floor(a.length / 2);
    return Math.round(((a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2)) * 10) / 10;
  };

  return {
    reached: { invited, onboarding, underReview, approved },
    conversion: {
      invited_to_onboarding: invited ? Math.round((onboarding / invited) * 1000) / 10 : null,
      onboarding_to_review: onboarding ? Math.round((underReview / onboarding) * 1000) / 10 : null,
      review_to_approved: underReview ? Math.round((approved / underReview) * 1000) / 10 : null,
    },
    medianDaysInStage: { invited_to_onboarding: median(dur.inv_onb), onboarding_to_review: median(dur.onb_sub), review_to_approved: median(dur.sub_app) },
    dropOff: { invited_not_onboarding: invited - onboarding, onboarding_not_review: onboarding - underReview, review_not_approved: underReview - approved },
    coverage: { complete: invited, total: M },
    note: `Based on ${invited} of ${M} vendors with complete event coverage (an 'invited' timestamp in the audit trail).`,
  };
}

// ── #5 Deficiency & Exception Analysis ───────────────────────────────────────────────

async function deficiencyAnalysis(db: Db, tenantId: string, vendorIds: string[], filters: ReportFilters, nowMs: number) {
  const tdb = new TenantDB(db, tenantId);
  if (vendorIds.length === 0) return { ranked: [], byTrade: [], range: { from: '', to: '' } };
  const to = filters.to ?? new Date(nowMs).toISOString();
  const from = filters.from ?? new Date(nowMs - 90 * DAY).toISOString();

  const evals = await tdb.all<{ requirement_key: string; outcome: string; trade: string }>(
    `SELECT re.requirement_key, re.outcome, v.trade
     FROM requirement_evaluations re
     JOIN verification_runs vr ON vr.id = re.run_id AND vr.tenant_id = re.tenant_id
     JOIN vendors v ON v.id = re.vendor_id AND v.tenant_id = re.tenant_id
     WHERE re.tenant_id = $1 AND re.outcome IN ('deficient','uncertain')
       AND re.vendor_id IN (${inClause(vendorIds.length, 4)})
       AND vr.created_at >= $2 AND vr.created_at <= $3
       ${filters.trade ? `AND v.trade = $${4 + vendorIds.length}` : ''}`,
    [from, to, ...vendorIds, ...(filters.trade ? [filters.trade] : [])]
  );

  const byKey = new Map<string, { deficient: number; uncertain: number }>();
  const byTradeKey = new Map<string, number>();
  for (const e of evals) {
    const cur = byKey.get(e.requirement_key) ?? { deficient: 0, uncertain: 0 };
    if (e.outcome === 'deficient') cur.deficient++; else cur.uncertain++;
    byKey.set(e.requirement_key, cur);
    if (e.outcome === 'deficient') byTradeKey.set(e.trade, (byTradeKey.get(e.trade) ?? 0) + 1);
  }
  const ranked = [...byKey.entries()]
    .map(([requirement_key, c]) => ({ requirement_key, deficient: c.deficient, uncertain: c.uncertain, total: c.deficient + c.uncertain }))
    .sort((a, b) => b.total - a.total);
  const byTrade = [...byTradeKey.entries()].map(([trade, deficient]) => ({ trade, deficient })).sort((a, b) => b.deficient - a.deficient);
  return { ranked, byTrade, range: { from, to } };
}

// ── #6 Audit-Readiness Summary ────────────────────────────────────────────────────────

async function auditReadiness(db: Db, tenantId: string, vendorIds: string[], effLoc: string[] | null, nowMs: number) {
  const posture = (await compliancePosture(db, tenantId, vendorIds, {}, effLoc, nowMs)).snapshot;
  const forecast = (await renewalForecast(db, tenantId, vendorIds, effLoc, nowMs)).buckets;
  const counts = posture.counts;
  const openExceptions =
    (counts['under_review'] ?? 0) + (counts['non_compliant'] ?? 0) + (counts['expired'] ?? 0);
  const coverageGaps = (counts['non_compliant'] ?? 0) + (counts['expired'] ?? 0);
  const renewalExposure90d = forecast.d30 + forecast.d60 + forecast.d90;
  return {
    posture,
    coverageGaps,
    openExceptions,
    renewalExposure90d,
    linksToAuditExport: true,
    note: 'Management summary. For the event-level evidentiary record, generate an Audit Export.',
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────────────

export async function runReport(
  db: Db,
  tenantId: string,
  scope: ReportScope,
  key: ReportKey,
  filters: ReportFilters = {},
  nowMs: number = Date.now()
): Promise<ReportResult> {
  const meta = reportMeta(key)!;
  const effLoc = await effectiveLocationIds(db, tenantId, scope, filters);
  const vendorIds = await vendorIdsInScope(db, tenantId, effLoc);

  let data: unknown;
  switch (key) {
    case 'compliance-posture': data = await compliancePosture(db, tenantId, vendorIds, filters, effLoc, nowMs); break;
    case 'renewal-forecast': data = await renewalForecast(db, tenantId, vendorIds, effLoc, nowMs); break;
    case 'vendor-roster': data = await vendorRoster(db, tenantId, vendorIds, effLoc); break;
    case 'onboarding-funnel': data = await onboardingFunnel(db, tenantId, vendorIds); break;
    case 'deficiency-analysis': data = await deficiencyAnalysis(db, tenantId, vendorIds, filters, nowMs); break;
    case 'audit-readiness': data = await auditReadiness(db, tenantId, vendorIds, effLoc, nowMs); break;
  }

  return { meta, generatedAt: new Date(nowMs).toISOString(), filters, data };
}
