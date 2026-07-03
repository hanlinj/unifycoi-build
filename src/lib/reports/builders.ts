// The six report builders. Pure reads; Sensitive data never touched (these query
// vendor_locations, audit_events, requirement_evaluations, chase notifications, and COI
// coverage fields only — no W-9/ACH Sensitive leaves).

import type Database from 'better-sqlite3';
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

function compliancePosture(db: Database.Database, tenantId: string, vendorIds: string[], filters: ReportFilters, effLoc: string[] | null, nowMs: number) {
  const tdb = new TenantDB(db, tenantId);

  // Current snapshot — counts of vendor_locations by status, within scope.
  const locFilter = effLoc === null ? '' : effLoc.length === 0 ? ' AND 1=0' : ` AND location_id IN (${inClause(effLoc)})`;
  const snapRows = tdb.all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM vendor_locations WHERE tenant_id = ?${locFilter} GROUP BY status`,
    effLoc ?? []
  );
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of snapRows) { counts[r.status] = r.n; total += r.n; }
  const approved = counts['approved'] ?? 0;
  const compliantPct = total > 0 ? Math.round((approved / total) * 1000) / 10 : 0;

  // Trend — status-transition audit events bucketed by month over [from, to].
  const to = filters.to ?? new Date(nowMs).toISOString();
  const from = filters.from ?? new Date(nowMs - 180 * DAY).toISOString();
  const TREND_TYPES = ['vendor.approved', 'vendor.expired', 'vendor.non_compliant_rule_change', 'vendor.declined', 'vendor.submitted', 'vendor.onboarding_started'] as const;
  const trend: Record<string, Record<string, number>> = {};
  if (vendorIds.length > 0) {
    const evs = tdb.all<{ event_type: string; created_at: string }>(
      `SELECT event_type, created_at FROM audit_events
       WHERE tenant_id = ? AND target_type = 'vendor' AND target_id IN (${inClause(vendorIds)})
         AND event_type IN (${inClause(TREND_TYPES as unknown as string[])})
         AND created_at >= ? AND created_at <= ?`,
      [...vendorIds, ...TREND_TYPES, from, to]
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

function renewalForecast(db: Database.Database, tenantId: string, vendorIds: string[], effLoc: string[] | null, nowMs: number) {
  const tdb = new TenantDB(db, tenantId);
  // OPS-7: days-out resolves the expiry boundary in the tenant's timezone (matches the flip
  // + Command Center buckets). Null tz → UTC.
  const tz = (db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(tenantId) as { timezone: string | null } | undefined)?.timezone ?? null;
  if (vendorIds.length === 0) return { rows: [], buckets: { d30: 0, d60: 0, d90: 0, beyond: 0 } };

  // Queued chase rows for in-scope vendors → earliest expiration + nearest pending rung.
  const chase = tdb.all<{ vendor_id: string; exp: string | null; rung: number | null }>(
    `SELECT json_extract(payload_json,'$.vendor_id') AS vendor_id,
            MIN(json_extract(payload_json,'$.expiration_date')) AS exp,
            MIN(json_extract(payload_json,'$.days_before')) AS rung
     FROM notifications
     WHERE tenant_id = ? AND status = 'queued'
       AND json_extract(payload_json,'$.type') IN ('renewal_reminder','coi_expiration')
       AND json_extract(payload_json,'$.vendor_id') IN (${inClause(vendorIds)})
     GROUP BY json_extract(payload_json,'$.vendor_id')`,
    vendorIds
  );

  const buckets = { d30: 0, d60: 0, d90: 0, beyond: 0 };
  const rows = chase
    .filter((c) => c.exp)
    .map((c) => {
      const daysOut = Math.floor((expiryBoundaryMs(c.exp!, tz) - nowMs) / DAY);
      const bucket = daysOut <= 30 ? 'd30' : daysOut <= 60 ? 'd60' : daysOut <= 90 ? 'd90' : 'beyond';
      buckets[bucket as keyof typeof buckets]++;
      const v = tdb.get<{ business_name: string; trade: string }>('SELECT business_name, trade FROM vendors WHERE tenant_id = ? AND id = ?', [c.vendor_id])!;
      const locs = tdb
        .all<{ name: string }>(
          `SELECT l.name FROM vendor_locations vl JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
           WHERE vl.tenant_id = ? AND vl.vendor_id = ?${effLoc === null ? '' : ` AND vl.location_id IN (${inClause(effLoc)})`}`,
          effLoc === null ? [c.vendor_id] : [c.vendor_id, ...effLoc]
        )
        .map((r) => r.name);
      return { vendorId: c.vendor_id, vendorName: v.business_name, trade: v.trade, locations: locs, expirationDate: c.exp!, daysOut, bucket, nextRung: c.rung };
    })
    .sort((a, b) => a.daysOut - b.daysOut);

  return { rows, buckets };
}

// ── #3 Vendor Roster & Coverage (Standard coverage facts only) ──────────────────────

function vendorRoster(db: Database.Database, tenantId: string, vendorIds: string[], effLoc: string[] | null) {
  const tdb = new TenantDB(db, tenantId);
  const rows = vendorIds.map((vid) => {
    const v = tdb.get<{ business_name: string; trade: string }>('SELECT business_name, trade FROM vendors WHERE tenant_id = ? AND id = ?', [vid])!;
    const vls = tdb.all<{ location_id: string; name: string; status: string }>(
      `SELECT vl.location_id, l.name, vl.status FROM vendor_locations vl
       JOIN locations l ON l.id = vl.location_id AND l.tenant_id = vl.tenant_id
       WHERE vl.tenant_id = ? AND vl.vendor_id = ?${effLoc === null ? '' : ` AND vl.location_id IN (${inClause(effLoc)})`}`,
      effLoc === null ? [vid] : [vid, ...effLoc]
    );
    const coverage = coiCoverageSummary(db, tenantId, vid);
    return {
      vendorId: vid,
      vendorName: v.business_name,
      trade: v.trade,
      overallStatus: deriveOverall(vls.map((x) => x.status)),
      locations: vls.map((x) => x.name),
      coverage,
    };
  }).sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  return { rows };
}

/** Compact Standard coverage facts from the latest active COI extraction (no Sensitive data). */
function coiCoverageSummary(db: Database.Database, tenantId: string, vendorId: string): { glEachOccurrence: number | null; additionalInsured: boolean | null; waiverOfSubrogation: boolean | null } {
  const tdb = new TenantDB(db, tenantId);
  const doc = tdb.get<{ id: string }>(
    `SELECT d.id FROM documents d WHERE d.tenant_id = ? AND d.vendor_id = ? AND d.doc_type = 'coi' AND d.state = 'active' AND d.superseded_by IS NULL ORDER BY d.uploaded_at DESC LIMIT 1`,
    [vendorId]
  );
  if (!doc) return { glEachOccurrence: null, additionalInsured: null, waiverOfSubrogation: null };
  const ex = tdb.get<{ payload_json: string }>(
    'SELECT payload_json FROM extractions WHERE tenant_id = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1',
    [doc.id]
  );
  if (!ex) return { glEachOccurrence: null, additionalInsured: null, waiverOfSubrogation: null };
  try {
    const p = JSON.parse(ex.payload_json) as { policies?: Array<{ coverage_type?: { value?: string }; limits?: Record<string, { value?: number }>; additional_insured?: { value?: boolean }; waiver_of_subrogation?: { value?: boolean } }> };
    const policies = p.policies ?? [];
    const gl = policies.find((pol) => /general|gl/i.test(pol.coverage_type?.value ?? '')) ?? policies[0];
    const glEach = gl?.limits ? (Object.entries(gl.limits).find(([k]) => /each_occurrence/i.test(k))?.[1]?.value ?? null) : null;
    const ai = policies.some((pol) => pol.additional_insured?.value === true) ? true : policies.length ? false : null;
    const wos = policies.some((pol) => pol.waiver_of_subrogation?.value === true) ? true : policies.length ? false : null;
    return { glEachOccurrence: glEach ?? null, additionalInsured: ai, waiverOfSubrogation: wos };
  } catch {
    return { glEachOccurrence: null, additionalInsured: null, waiverOfSubrogation: null };
  }
}

// ── #4 Onboarding Throughput & Funnel ────────────────────────────────────────────────

function onboardingFunnel(db: Database.Database, tenantId: string, vendorIds: string[]) {
  const tdb = new TenantDB(db, tenantId);
  const M = vendorIds.length;
  if (M === 0) return { reached: { invited: 0, onboarding: 0, underReview: 0, approved: 0 }, conversion: {}, medianDaysInStage: {}, dropOff: {}, coverage: { complete: 0, total: 0 }, note: '' };

  // Earliest timestamp per vendor per stage from the audit trail.
  const stamp = new Map<string, { invited?: string; onboarding?: string; submitted?: string; approved?: string }>();
  const evs = tdb.all<{ target_id: string; event_type: string; created_at: string }>(
    `SELECT target_id, event_type, created_at FROM audit_events
     WHERE tenant_id = ? AND target_type = 'vendor' AND target_id IN (${inClause(vendorIds)})
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

function deficiencyAnalysis(db: Database.Database, tenantId: string, vendorIds: string[], filters: ReportFilters, nowMs: number) {
  const tdb = new TenantDB(db, tenantId);
  if (vendorIds.length === 0) return { ranked: [], byTrade: [], range: { from: '', to: '' } };
  const to = filters.to ?? new Date(nowMs).toISOString();
  const from = filters.from ?? new Date(nowMs - 90 * DAY).toISOString();

  const evals = tdb.all<{ requirement_key: string; outcome: string; trade: string }>(
    `SELECT re.requirement_key, re.outcome, v.trade
     FROM requirement_evaluations re
     JOIN verification_runs vr ON vr.id = re.run_id AND vr.tenant_id = re.tenant_id
     JOIN vendors v ON v.id = re.vendor_id AND v.tenant_id = re.tenant_id
     WHERE re.tenant_id = ? AND re.outcome IN ('deficient','uncertain')
       AND re.vendor_id IN (${inClause(vendorIds)})
       AND vr.created_at >= ? AND vr.created_at <= ?
       ${filters.trade ? 'AND v.trade = ?' : ''}`,
    [...vendorIds, from, to, ...(filters.trade ? [filters.trade] : [])]
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

function auditReadiness(db: Database.Database, tenantId: string, vendorIds: string[], effLoc: string[] | null, nowMs: number) {
  const posture = compliancePosture(db, tenantId, vendorIds, {}, effLoc, nowMs).snapshot;
  const forecast = renewalForecast(db, tenantId, vendorIds, effLoc, nowMs).buckets;
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

export function runReport(
  db: Database.Database,
  tenantId: string,
  scope: ReportScope,
  key: ReportKey,
  filters: ReportFilters = {},
  nowMs: number = Date.now()
): ReportResult {
  const meta = reportMeta(key)!;
  const effLoc = effectiveLocationIds(db, tenantId, scope, filters);
  const vendorIds = vendorIdsInScope(db, tenantId, effLoc);

  let data: unknown;
  switch (key) {
    case 'compliance-posture': data = compliancePosture(db, tenantId, vendorIds, filters, effLoc, nowMs); break;
    case 'renewal-forecast': data = renewalForecast(db, tenantId, vendorIds, effLoc, nowMs); break;
    case 'vendor-roster': data = vendorRoster(db, tenantId, vendorIds, effLoc); break;
    case 'onboarding-funnel': data = onboardingFunnel(db, tenantId, vendorIds); break;
    case 'deficiency-analysis': data = deficiencyAnalysis(db, tenantId, vendorIds, filters, nowMs); break;
    case 'audit-readiness': data = auditReadiness(db, tenantId, vendorIds, effLoc, nowMs); break;
  }

  return { meta, generatedAt: new Date(nowMs).toISOString(), filters, data };
}
